// 本地 Wallpaper Engine 壁纸扫描（Steam 创意工坊 AppID 431960）。
//
// 目标目录：<Steam 库>\steamapps\workshop\content\431960\<创意工坊 id>\
// 发现顺序：
//   1) settings.wallpaperEngineDir 非空 → 直接用它（既接受 content\431960 本身，也接受库根/steamapps）；
//   2) 否则自动探测常见 Steam 安装位置 + 各盘符下的 Steam / SteamLibrary，
//      再读 steamapps/libraryfolders.vdf 里所有 "path" 库目录（正则解析，不引依赖）；
//   3) 候选去重、只保留真实存在的目录。
// 每个项目目录最多看 2 层（项目目录 + video/ 之类的一层子目录），只返回「有视频可播」的条目。
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { WallpaperEntry } from "../../shared/types";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { mt } from "../core/i18n";

const log = logger("media/wallpaper");

/** Wallpaper Engine 的 Steam AppID。 */
const APP_ID = "431960";
const VIDEO_EXTS = new Set([".mp4", ".webm", ".ogv"]);
/** 静态图壁纸能用的图片后缀（project.json.file 是图片时直接当背景）。 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PREVIEW_NAMES = ["preview.jpg", "preview.png", "preview.gif", "preview.jpeg", "preview.webp"];
/** 结果缓存 30 秒：设置页会反复拉这个列表。 */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  dirs: string[];
  entries: WallpaperEntry[];
}

let cache: CacheEntry | null = null;

/** project.json 里我们关心的字段（容错：BOM、缺字段、类型不对）。 */
export interface WallpaperProjectMeta {
  title?: string;
  type?: string;
  file?: string;
  preview?: string;
}

/** 解析 project.json：去掉 BOM 再 JSON.parse，坏文件返回空对象。 */
export function parseProjectJson(text: string): WallpaperProjectMeta {
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(clean);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = obj[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  return { title: pick("title"), type: pick("type"), file: pick("file"), preview: pick("preview") };
}

/**
 * 解析 libraryfolders.vdf：新版每行是 "path" 后跟库路径，老版是数字键后跟路径。
 * 两种都收；路径里的双反斜杠还原成单反斜杠。
 */
export function parseLibraryFolders(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const path = raw.replace(/\\\\/g, "\\").trim();
    if (!path) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };
  for (const match of text.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) push(match[1]);
  // 老格式：键是数字（0/1/2…），值才是路径。两个约束：
  //   · 键必须在行首（否则会把上一行的值当成键，例如 "TimeNextStatsReport" "1" 的 "1"）；
  //   · 值必须像路径（新版 VDF 的 apps 表里还有 "431960" "123" 这种键值对）。
  for (const match of text.matchAll(/^[ \t]*"\d+"[ \t]+"((?:[^"\\]|\\.)*)"/gm)) {
    if (!/[\\/]/.test(match[1])) continue;
    push(match[1]);
  }
  return out;
}

async function isDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return Boolean(info && info.isDirectory());
}

/** 目录里是否有数字子目录（有就说明它是 content\431960 本身）。 */
async function hasProjectDirs(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
}

/** 把「用户填的目录」展开成可能的 431960 目录（不判断存在性）。 */
export function expandUserDir(raw: string): string[] {
  const dir = raw.trim();
  if (!dir) return [];
  return [
    dir, // 用户直接指到 content\431960
    join(dir, "steamapps", "workshop", "content", APP_ID), // 指到库根
    join(dir, "workshop", "content", APP_ID), // 指到 steamapps
  ];
}

/** 常见 Steam 安装根：环境变量 + 每个盘符下的几个常见名字。 */
function steamRootCandidates(): string[] {
  const env = process.env;
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const roots = new Set<string>([
    join(programFilesX86, "Steam"),
    join(programFiles, "Steam"),
    join(programFilesX86, "SteamLibrary"),
    join(programFiles, "SteamLibrary"),
  ]);
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZAB") {
    const drive = letter + ":\\";
    roots.add(join(drive, "Steam"));
    roots.add(join(drive, "SteamLibrary"));
    roots.add(join(drive, "Program Files (x86)", "Steam"));
    roots.add(join(drive, "Games", "Steam"));
  }
  return [...roots];
}

/** 读某个 Steam 根下的 libraryfolders.vdf 并展开所有库的 431960 目录。 */
async function dirsOfSteamRoot(root: string): Promise<string[]> {
  const out: string[] = [join(root, "steamapps", "workshop", "content", APP_ID)];
  const vdf = join(root, "steamapps", "libraryfolders.vdf");
  const text = await readFile(vdf, "utf8").catch(() => undefined);
  if (!text) return out;
  for (const lib of parseLibraryFolders(text)) {
    out.push(join(lib, "steamapps", "workshop", "content", APP_ID));
  }
  return out;
}

/**
 * 解析出所有真实存在的 431960 目录（去重、按路径排序）。
 * 用户显式设置了目录时只用它（不混入自动探测，避免用户指错了还看到别的库）。
 */
export async function resolveWallpaperDirs(): Promise<string[]> {
  const configured = (getSettings().wallpaperEngineDir ?? "").trim();
  const candidates: string[] = [];
  if (configured) {
    for (const candidate of expandUserDir(configured)) {
      if (await hasProjectDirs(candidate)) candidates.push(candidate);
    }
    // 用户指到 content\431960 时可能是空目录（还没订阅壁纸），也要认
    if (candidates.length === 0 && (await isDir(configured))) candidates.push(configured);
  } else {
    for (const root of steamRootCandidates()) {
      if (!(await isDir(root))) continue;
      candidates.push(...(await dirsOfSteamRoot(root)));
    }
  }
  const existing: string[] = [];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await isDir(dir))) continue;
    existing.push(dir);
  }
  existing.sort((a, b) => a.localeCompare(b));
  return existing;
}

/** 项目目录里（含一层子目录）找第一个视频文件。 */
async function findVideo(dir: string, preferred?: string): Promise<string> {
  if (preferred && VIDEO_EXTS.has(extname(preferred).toLowerCase())) {
    const target = join(dir, preferred);
    if (existsSync(target)) return target;
  }
  const level1 = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = level1
    .filter((entry) => entry.isFile() && VIDEO_EXTS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
  if (files.length > 0) return join(dir, files[0]);
  // 只能再看一层：video/ 之类的子目录
  for (const entry of level1) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    const inner = (await readdir(sub, { withFileTypes: true }).catch(() => []))
      .filter((item) => item.isFile() && VIDEO_EXTS.has(extname(item.name).toLowerCase()))
      .map((item) => item.name)
      .sort();
    if (inner.length > 0) return join(sub, inner[0]);
  }
  return "";
}

/** 预览图：project.json.preview 优先，其次约定的 preview.* 文件名（含一层子目录）。 */
async function findPreview(dir: string, preferred?: string): Promise<string> {
  if (preferred) {
    const target = join(dir, preferred);
    if (existsSync(target)) return target;
  }
  for (const name of PREVIEW_NAMES) {
    const target = join(dir, name);
    if (existsSync(target)) return target;
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    for (const name of PREVIEW_NAMES) {
      const target = join(sub, name);
      if (existsSync(target)) return target;
    }
  }
  return "";
}

/** project.json.file 本身是图片时，它就是静态背景图（image/gif 型壁纸常这么写）。 */
async function findImageFile(dir: string, fileName?: string): Promise<string> {
  if (!fileName) return "";
  if (!IMAGE_EXTS.has(extname(fileName).toLowerCase())) return "";
  const target = join(dir, fileName);
  return existsSync(target) ? target : "";
}

/**
 * 扫描单个创意工坊项目目录：
 * · 有视频 → videoPath 有值，imagePath 用预览图兜底（视频壁纸也能当静态背景）；
 * · 没视频但有 type（image/gif/web…）且能找到图片 → videoPath 为空串、imagePath 填图片；
 * · 两者都没有 → 不返回（scene 只剩 .pkg 这类没图可用的项目就到不了前台）。
 */
export async function scanProjectDir(id: string, dir: string): Promise<WallpaperEntry | undefined> {
  const text = await readFile(join(dir, "project.json"), "utf8").catch(() => "");
  const meta = parseProjectJson(text);
  const videoPath = await findVideo(dir, meta.file);
  const previewPath = await findPreview(dir, meta.preview);
  // 图片候选：project.json.file 本身是图片优先，其次才是预览图
  const imagePath = (await findImageFile(dir, meta.file)) || previewPath;
  // web 型壁纸是网页，启动器渲染不了（会显示成一张静态预览图，误导用户），直接不列出
  if ((meta.type ?? "").toLowerCase() === "web") return undefined;
  // scene 型同理：scene.pkg 需要壁纸引擎自己的渲染器，这里只能拿到预览图
  if ((meta.type ?? "").toLowerCase() === "scene") return undefined;
  if (!videoPath) {
    // 静态图壁纸：必须声明了 type 且真的找到图片，否则视为不支持
    if (!meta.type || !imagePath) return undefined;
    return { id, title: meta.title ?? id, dir, videoPath: "", previewPath, imagePath, kind: meta.type };
  }
  return {
    id,
    title: meta.title ?? id,
    dir,
    videoPath,
    previewPath,
    // 视频壁纸的静态图就是预览图（没有预览图时为空串）
    imagePath,
    kind: meta.type ?? "",
  };
}

/** 扫描一个 content\431960 目录下的所有项目（只留能播的）。 */
export async function scanWorkshopDir(dir: string): Promise<WallpaperEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: WallpaperEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const item = await scanProjectDir(entry.name, join(dir, entry.name));
    if (item) out.push(item);
  }
  return out;
}

/**
 * 列出所有本地壁纸（缓存 30 秒；force=true 跳过缓存）。
 * 按 title 排序；一个目录都没有时记一条 info，说明探测过哪些路径，方便用户自查。
 */
export async function listWallpapers(force = false): Promise<WallpaperEntry[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  const dirs = await resolveWallpaperDirs();
  if (dirs.length === 0) {
    const configured = (getSettings().wallpaperEngineDir ?? "").trim();
    log.info(
      mt("media.wallpaperNotFound") +
        (configured ? mt("media.wallpaperConfigured", { path: configured }) : mt("media.wallpaperProbed")),
    );
    cache = { at: Date.now(), dirs, entries: [] };
    return [];
  }
  const all: WallpaperEntry[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const item of await scanWorkshopDir(dir)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  }
  all.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  cache = { at: Date.now(), dirs, entries: all };
  log.info("已扫描 Wallpaper Engine 壁纸：" + all.length + " 个可播放项目（目录 " + dirs.join("; ") + "）");
  return all;
}

/** 清缓存（设置里换了目录后调用）。 */
export function invalidateWallpaperCache(): void {
  cache = null;
}
