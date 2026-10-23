// 随机图 API → 本地缓存文件。
//
// 为什么先落临时文件再判断类型：core/http 的 downloadFile 只回字节、不暴露 content-type，
// 而文件头（magic bytes）比 content-type 可靠得多（不少图床把 jpeg 标成 application/octet-stream）。
// 流程：
//   1) GET settings.backgroundApiUrl（10 秒超时，AbortSignal 控制；UA 由 core/http 统一发送）；
//   2) 文件头是图片/视频 → 直接当媒体；否则按文本读（JSON 优先，失败按纯文本）找第一个媒体地址；
//   3) 再把这个媒体地址下载下来，落盘到 <dataRoot>/cache/backgrounds/api-<内容 sha1 前 16 位>.<扩展名>；
//   4) 只保留最近 8 个 api-* 文件；
//   5) 返回 { url: 本地绝对路径, kind, source: 原始接口地址 }；任何失败都 log.warn 返回 null。
// 防抖：同一接口地址 2 秒内重复调用直接返回上次结果（界面连点不会把网刷爆）。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ApiBackground } from "../../shared/types";
import { downloadFile } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";

const log = logger("media/api");

/** 单次网络请求上限：接口/媒体都按 10 秒算。 */
const TIMEOUT_MS = 10_000;
/** 缓存里只留最近 8 张。 */
const KEEP_FILES = 8;
/** 同一接口 2 秒内复用上次结果。 */
const DEBOUNCE_MS = 2_000;
/** 文本响应最多读这么多，避免某些接口返回巨大 JSON 把内存吃满。 */
const MAX_TEXT_BYTES = 1024 * 1024;

const IMAGE_MAGIC: Array<{ ext: string; test: (buf: Buffer) => boolean }> = [
  { ext: ".jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".png", test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: ".gif", test: (b) => b.length > 6 && b.toString("latin1", 0, 4) === "GIF8" },
  { ext: ".webp", test: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  { ext: ".bmp", test: (b) => b.length > 2 && b.toString("latin1", 0, 2) === "BM" },
];

const VIDEO_MAGIC: Array<{ ext: string; test: (buf: Buffer) => boolean }> = [
  { ext: ".mp4", test: (b) => b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" },
  { ext: ".webm", test: (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 },
  { ext: ".ogv", test: (b) => b.length > 4 && b.toString("latin1", 0, 4) === "OggS" },
];

export interface SniffedMedia {
  kind: "image" | "video";
  ext: string;
}

/** 按文件头判断是不是图片/视频；都不是返回 undefined（交给文本解析）。 */
export function sniffMedia(bytes: Buffer): SniffedMedia | undefined {
  for (const item of IMAGE_MAGIC) {
    if (item.test(bytes)) return { kind: "image", ext: item.ext };
  }
  for (const item of VIDEO_MAGIC) {
    if (item.test(bytes)) return { kind: "video", ext: item.ext };
  }
  return undefined;
}

/** 按扩展名/关键字猜是不是媒体地址（文本里找链接时用）。 */
const MEDIA_URL_RE = /^https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|ogv)(?:\?[^\s"'<>]*)?$/i;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  return "";
}

/** 递归找「看起来像媒体」的 http(s) 地址（兜底用）。 */
function deepFindMediaUrl(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    const text = value.trim();
    return MEDIA_URL_RE.test(text) ? text : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindMediaUrl(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = deepFindMediaUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/**
 * 从 JSON 里按常见字段顺序取第一个 http(s) 地址；都没有就递归找媒体后缀的链接。
 * 字段顺序按任务书：url / image / imgurl / img / pic / cover / data.* / images[0] / hits[0].largeImageURL …
 */
export function extractMediaUrlFromJson(raw: unknown): string {
  const root = asObject(raw);
  const data = asObject(root.data);
  const images = Array.isArray(root.images) ? root.images[0] : undefined;
  const hits = Array.isArray(root.hits) ? root.hits[0] : undefined;
  const candidates: unknown[] = [
    root.url,
    root.image,
    root.imgurl,
    root.img,
    root.pic,
    root.cover,
    data.url,
    data.image,
    asObject(images).url,
    images,
    asObject(hits).largeImageURL,
    root.largeImageURL,
  ];
  for (const candidate of candidates) {
    const value = firstString(candidate);
    if (/^https?:\/\//i.test(value)) return value;
  }
  return deepFindMediaUrl(raw);
}

/** 纯文本里找第一个 http(s) 媒体地址；找不到时退而求其次取第一行像 URL 的内容。 */
export function extractMediaUrlFromText(text: string): string {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of matches) {
    if (MEDIA_URL_RE.test(candidate)) return candidate;
  }
  return "";
}

function cacheDir(): string {
  return join(getPaths().dataRoot, "cache", "backgrounds");
}

function sha1Of(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 带 10 秒超时的下载：用 AbortSignal 控制 core/http 的传输。 */
async function downloadWithTimeout(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    await downloadFile(url, dest, { label: "随机图背景", signal: linked, connections: 1 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只保留最近 KEEP_FILES 个 api-* 文件（按修改时间倒序，其余删除）。
 * 同时清掉超过 10 分钟的 .probe-* 残留：下载中途取消/进程被结束时 finally 可能来不及跑，
 * 这些半截文件没有名字里的哈希可复用，留着只是占空间。
 */
async function pruneCache(dir: string): Promise<void> {
  const all = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of all.filter((item) => item.startsWith(".probe-"))) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info && now - info.mtimeMs > 10 * 60 * 1000) {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }
  const names = all.filter((name) => name.startsWith("api-"));
  const items: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info) items.push({ name, mtime: info.mtimeMs });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  for (const stale of items.slice(KEEP_FILES)) {
    await rm(join(dir, stale.name), { force: true }).catch(() => undefined);
    log.info("清理旧随机图背景缓存：" + stale.name);
  }
}

/** 下载一个地址到缓存目录，返回 { 绝对路径, kind }。 */
async function cacheFromUrl(url: string, dir: string, source: string): Promise<ApiBackground> {
  const tmp = join(dir, ".probe-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
  try {
    await downloadWithTimeout(url, tmp);
    const bytes = await readFile(tmp);
    const sniffed = sniffMedia(bytes);
    if (!sniffed) {
      throw new Error("该地址返回的不是图片/视频（" + bytes.length + " 字节）");
    }
    const final = join(dir, "api-" + sha1Of(bytes).slice(0, 16) + sniffed.ext);
    // 同一张图重复获取时名字相同：直接覆盖，等于命中缓存
    await rm(final, { force: true }).catch(() => undefined);
    await rename(tmp, final);
    return { url: final, kind: sniffed.kind, source };
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** 是媒体就直接缓存；是文本就解析出媒体地址再缓存。 */
async function resolveFromApi(rawUrl: string, dir: string): Promise<ApiBackground> {
  const probe = join(dir, ".probe-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
  try {
    await downloadWithTimeout(rawUrl, probe);
    const bytes = await readFile(probe);
    const sniffed = sniffMedia(bytes);
    if (sniffed) {
      // 直出图片/视频：内容寻址落盘
      const final = join(dir, "api-" + sha1Of(bytes).slice(0, 16) + sniffed.ext);
      await rm(final, { force: true }).catch(() => undefined);
      await rename(probe, final);
      return { url: final, kind: sniffed.kind, source: rawUrl };
    }
    // 不是媒体：当文本处理（JSON 优先，失败按纯文本），文本上限 1MB
    const text = bytes.subarray(0, MAX_TEXT_BYTES).toString("utf8");
    let mediaUrl = "";
    try {
      mediaUrl = extractMediaUrlFromJson(JSON.parse(text.replace(/^\uFEFF/, "").trim()));
    } catch {
      mediaUrl = "";
    }
    if (!mediaUrl) mediaUrl = extractMediaUrlFromText(text);
    if (!mediaUrl) {
      const preview = text.replace(/\s+/g, " ").slice(0, 120);
      throw new Error("响应里没有找到图片/视频地址（前 120 字符：" + preview + "）");
    }
    log.info("随机图接口返回的是文本，已解析出媒体地址：" + mediaUrl);
    return await cacheFromUrl(mediaUrl, dir, rawUrl);
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

interface DebounceEntry {
  input: string;
  at: number;
  value: ApiBackground | null;
}

let lastCall: DebounceEntry | null = null;

/**
 * 把 settings.backgroundApiUrl 解析成本地缓存文件（失败返回 null，绝不抛给渲染层）。
 * 同一地址 2 秒内重复调用直接复用上次结果。
 */
export async function resolveApiBackground(): Promise<ApiBackground | null> {
  const url = (getSettings().backgroundApiUrl ?? "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    log.warn("随机图接口地址不是 http(s)：" + url);
    return null;
  }
  if (lastCall && lastCall.input === url && Date.now() - lastCall.at < DEBOUNCE_MS) {
    return lastCall.value;
  }
  const dir = cacheDir();
  try {
    await mkdir(dir, { recursive: true });
    const value = await resolveFromApi(url, dir);
    await pruneCache(dir);
    log.info("随机图背景已缓存：" + value.url + "（" + value.kind + "）");
    lastCall = { input: url, at: Date.now(), value };
    return value;
  } catch (err) {
    log.warn("随机图背景获取失败：" + messageOf(err));
    lastCall = { input: url, at: Date.now(), value: null };
    return null;
  }
}
