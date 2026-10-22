import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import AdmZip from "adm-zip";
import type { InstalledModInfo } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths, instanceModsDir } from "../core/paths";
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
