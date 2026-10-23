import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ModContentKind } from "../../shared/types";
import AdmZip from "adm-zip";
import type { InstalledModInfo } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths, instanceDir, instanceModsDir } from "../core/paths";
import { getSettings } from "../core/settings";
import { messageOf } from "./provider";

const log = logger("mods");

/** 扫描结果带绝对路径：checkUpdates 要按路径重算指纹，渲染进程看不到它。 */
export interface ScannedMod extends InstalledModInfo {
  path: string;
}

/** 流式哈希：模组 jar 可能几十 MB，不能整体读进内存。 */
export async function sha1OfFile(path: string): Promise<string> {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface ModMetadata {
  modId?: string;
  name?: string;
  version?: string;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readEntryText(zip: AdmZip, entryName: string): string | undefined {
  try {
    const entry = zip.getEntry(entryName);
    return entry ? entry.getData().toString("utf8") : undefined;
  } catch {
    // 单个条目损坏不能影响其它兜底来源
    return undefined;
  }
}

function mergeMetadata(list: ModMetadata[]): ModMetadata {
  const out: ModMetadata = {};
  for (const meta of list) {
    out.modId ??= meta.modId;
    out.name ??= meta.name;
    out.version ??= meta.version;
  }
  return out;
}

/** fabric.mod.json：id / name / version。 */
function fabricMetadata(text: string): ModMetadata | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const meta: ModMetadata = { modId: textOf(obj.id), name: textOf(obj.name), version: textOf(obj.version) };
  return meta.modId || meta.name || meta.version ? meta : undefined;
}

function unquote(value: string): string {
  const double = /^"(.*)"$/.exec(value);
  if (double) return double[1].replace(/\\(["\\])/g, "$1");
  const single = /^'(.*)'$/.exec(value);
  return single ? single[1] : value;
}

/** mods.toml / neoforge.mods.toml：只取第一个 [[mods]] 段，够用且不必引入 TOML 依赖。 */
function tomlMetadata(text: string): ModMetadata | undefined {
  const meta: ModMetadata = {};
  let inMods = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inMods = /^\[\[?\s*mods\s*\]\]?$/.test(line);
      continue;
    }
    if (!inMods) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (!value) continue;
    if (key === "modId") meta.modId ??= value;
    else if (key === "displayName") meta.name ??= value;
    else if (key === "version") meta.version ??= value;
  }
  return meta.modId || meta.name || meta.version ? meta : undefined;
}

/** MANIFEST.MF：续行以单个空格开头，必须拼回上一行。 */
function manifestMetadata(text: string): ModMetadata | undefined {
  const fields = new Map<string, string>();
  let last: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith(" ") && last) {
      fields.set(last, (fields.get(last) ?? "") + rawLine.slice(1));
      continue;
    }
    const colon = rawLine.indexOf(":");
    if (colon <= 0) continue;
    last = rawLine.slice(0, colon).trim().toLowerCase();
    fields.set(last, rawLine.slice(colon + 1).trim());
  }
  const name = textOf(fields.get("implementation-title"));
  const version = textOf(fields.get("implementation-version"));
  return name || version ? { name, version } : undefined;
}

/** 读 jar 内元数据；任何一步失败都退化为空对象，由调用方用文件名兜底。 */
export async function readModMetadata(path: string): Promise<ModMetadata> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(path);
  } catch (err) {
    log.warn(`模组元数据解析失败：${path} · ${messageOf(err)}`);
    return {};
  }

  const found: ModMetadata[] = [];
  const fabric = readEntryText(zip, "fabric.mod.json");
  if (fabric) {
    const meta = fabricMetadata(fabric);
    if (meta) found.push(meta);
  }
  for (const entryName of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
    const toml = readEntryText(zip, entryName);
    if (!toml) continue;
    const meta = tomlMetadata(toml);
    if (meta) found.push(meta);
  }
  const manifest = readEntryText(zip, "META-INF/MANIFEST.MF");
  if (manifest) {
    const meta = manifestMetadata(manifest);
    if (meta) found.push(meta);
  }
  return mergeMetadata(found);
}

function fallbackName(fileName: string): string {
  return basename(fileName, extname(fileName));
}

/**
 * 模组目录要跟实例隔离设置走：versionIsolation === "none" 时游戏的 --gameDir 就是 <gameRoot>，
 * 模组只有写进 <gameRoot>/mods 才会被加载，写实例目录等于装了个没人读的 jar。
 */
export function modsDirForInstance(instance: { id: string }): string {
  if (getSettings().versionIsolation === "none") return join(getPaths().gameRoot, "mods");
  return instanceModsDir(instance.id);
}

/**
 * 实例内的内容子目录（shaderpacks / resourcepacks 等），口径与模组目录一致：
 * 版本隔离为 none 时游戏读的是 <gameRoot>，写实例目录等于装了个没人读的包。
 * 规则单独放这里，install 与 dependencies 都复用它，避免 install ↔ installed 互相 import。
 */
export function contentDirOf(instance: { id: string }, sub: string): string {
  if (getSettings().versionIsolation === "none") return join(getPaths().gameRoot, sub);
  return join(instanceDir(instance.id), sub);
}

/** 扫描实例 mods 目录：只看 .jar（.bak 是备份，不是已装模组）。 */
export async function scanInstalledMods(instanceId: string): Promise<ScannedMod[]> {
  const dir = modsDirForInstance({ id: instanceId });
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const mods: ScannedMod[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      const sizeBytes = (await stat(path)).size;
      const sha1 = await sha1OfFile(path);
      const meta = await readModMetadata(path);
      mods.push({
        path,
        fileName: entry.name,
        sizeBytes,
        sha1,
        modId: meta.modId,
        name: meta.name ?? fallbackName(entry.name),
        version: meta.version,
        update: null,
      });
    } catch (err) {
      log.warn(`跳过无法读取的模组文件：${entry.name} · ${messageOf(err)}`);
    }
  }
  mods.sort((a, b) => (a.name ?? a.fileName).localeCompare(b.name ?? b.fileName) || a.fileName.localeCompare(b.fileName));
  return mods;
}

/** 光影/资源包的落盘子目录与界面名词。 */
const PACK_SUBDIR: Partial<Record<ModContentKind, string>> = {
  shader: "shaderpacks",
  resourcepack: "resourcepacks",
};

const PACK_NOUN: Partial<Record<ModContentKind, string>> = {
  shader: "光影",
  resourcepack: "资源包",
};

/**
 * pack.mcmeta 的 description 是聊天组件：字符串、{text}、[{text}] 都见过。
 * 递归取文本拼成一个字符串，拿不到就当作没有说明，不把 JSON 原样丢给界面。
 */
function packDescriptionText(value: unknown): string | undefined {
  if (typeof value === "string") return textOf(value);
  if (Array.isArray(value)) {
    const parts = value.map(packDescriptionText).filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return packDescriptionText(obj.text) ?? packDescriptionText(obj.extra);
  }
  return undefined;
}

/** 读 zip 内 pack.mcmeta 的 pack.description；解析失败只是少一句说明，不影响文件本身。 */
function readPackDescription(path: string): string | undefined {
  let zip: AdmZip;
  try {
    zip = new AdmZip(path);
  } catch {
    return undefined;
  }
  const text = readEntryText(zip, "pack.mcmeta");
  if (!text) return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    const pack = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).pack : undefined;
    const description = pack !== null && typeof pack === "object" ? (pack as Record<string, unknown>).description : undefined;
    return packDescriptionText(description);
  } catch {
    return undefined;
  }
}

/**
 * 扫描实例里的某类内容：mod 复用 mods 目录口径，光影/资源包只看对应目录下的 .zip。
 * 名称回退文件名，说明取 pack.mcmeta；目录不存在即视为没有。
 */
export async function scanInstalledContent(instanceId: string, kind: ModContentKind = "mod"): Promise<ScannedMod[]> {
  if (kind === "mod") return scanInstalledMods(instanceId);
  const sub = PACK_SUBDIR[kind];
  const noun = PACK_NOUN[kind];
  // 整合包/地图没有「已装内容」这个概念：给空列表，不去猜一个目录
  if (!sub || !noun) return [];

  const dir = contentDirOf({ id: instanceId }, sub);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const packs: ScannedMod[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue; // .bak 备份与目录都不算已装
    const path = join(dir, entry.name);
    try {
      const sizeBytes = (await stat(path)).size;
      packs.push({
        path,
        fileName: entry.name,
        sizeBytes,
        sha1: await sha1OfFile(path),
        name: fallbackName(entry.name),
        description: readPackDescription(path),
        update: null,
      });
    } catch (err) {
      log.warn(`跳过无法读取的${noun}文件：${entry.name} · ${messageOf(err)}`);
    }
  }
  packs.sort((a, b) => (a.name ?? a.fileName).localeCompare(b.name ?? b.fileName) || a.fileName.localeCompare(b.fileName));
  return packs;
}
