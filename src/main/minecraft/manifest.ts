import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { VersionBrief, VersionListSource } from "../../shared/types";
import { fetchJson } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { mapUrl } from "../core/sources";
import { mt } from "../core/i18n";

const log = logger("manifest");

const MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

interface ManifestEntry {
  id: string;
  type: string;
  releaseTime: string;
  url: string;
}

interface VersionManifest {
  latest?: { release: string; snapshot: string };
  versions: ManifestEntry[];
}

let manifestCache: VersionManifest | null = null;
const vanillaCache = new Map<string, any>();
const mergedCache = new Map<string, any>();

/** 版本清单来源只作用于元数据请求，文件下载源仍是 settings.downloadSource。 */
function versionListSource(): VersionListSource {
  const value = getSettings().versionListSource;
  return value === "official" || value === "bmclapi" ? value : "auto";
}

/**
 * 元数据抓取目标：
 * official → 官方地址、禁止跨源回退（强制官方）
 * bmclapi → 直接请求镜像地址、禁止跨源回退（强制镜像）
 * auto     → 官方地址 + core/http 的跨源回退（与原来一致）
 */
function metadataTarget(officialUrl: string): { url: string; allowMirror: boolean } {
  const source = versionListSource();
  if (source === "bmclapi") return { url: mapUrl(officialUrl, "bmclapi"), allowMirror: false };
  return { url: officialUrl, allowMirror: source === "auto" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function fetchMetadata<T>(officialUrl: string, label: string): Promise<T> {
  const source = versionListSource();
  const target = metadataTarget(officialUrl);
  log.info("版本清单来源 " + source + "：" + label + " → " + hostOf(target.url) + "（" + target.url + "）");
  return fetchJson<T>(target.url, { allowMirror: target.allowMirror, timeoutMs: 20000 });
}

/** auto 接受任意来源的缓存；强制源只认自己那份，切换来源后必须重新拉取。 */
function cacheSourceMatches(cachedSource: unknown): boolean {
  return versionListSource() === "auto" || cachedSource === versionListSource();
}

function manifestPath(): string {
  return join(getPaths().meta, "version_manifest_v2.json");
}

function vanillaPath(versionId: string): string {
  return join(getPaths().meta, "versions", `${versionId}.json`);
}

async function readJsonFile(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function normalizeType(type: string): VersionBrief["type"] {
  if (type === "release" || type === "snapshot" || type === "old_beta" || type === "old_alpha") return type;
  return "snapshot";
}

async function loadManifest(forceRefresh = false): Promise<VersionManifest> {
  const source = versionListSource();
  if (!forceRefresh) {
    if (manifestCache) return manifestCache;
    const cached = await readJsonFile(manifestPath());
    if (cached && Array.isArray(cached.versions) && cached.versions.length > 0 && cacheSourceMatches(cached.__source)) {
      manifestCache = cached as VersionManifest;
      return manifestCache;
    }
  }
  const fresh = await fetchMetadata<VersionManifest>(MANIFEST_URL, mt("manifest.labelList"));
  if (!fresh || !Array.isArray(fresh.versions) || fresh.versions.length === 0) {
    throw new Error(mt("manifest.badShape"));
  }
  manifestCache = fresh;
  // __source 记录这份缓存来自哪个来源，切来源后据此重新拉取
  await writeJsonFile(manifestPath(), { ...fresh, __source: source });
  log.info(`版本清单已更新，共 ${fresh.versions.length} 个版本（来源 ${source}）`);
  return fresh;
}

export async function listVersions(forceRefresh = false): Promise<VersionBrief[]> {
  const manifest = await loadManifest(forceRefresh);
  return manifest.versions.map((entry) => ({
    id: entry.id,
    type: normalizeType(entry.type),
    releaseTime: entry.releaseTime,
  }));
}

async function readInstalledVersionJson(versionId: string): Promise<any | null> {
  return readJsonFile(join(getPaths().versions, versionId, `${versionId}.json`));
}

/** 读取未合并的版本 JSON：优先本地已装版本，其次 meta 缓存/官方接口。 */
async function loadRawVersionJson(versionId: string): Promise<any | null> {
  const installed = await readInstalledVersionJson(versionId);
  if (installed) return installed;
  try {
    return await getVanillaJson(versionId);
  } catch {
    return null;
  }
}

/** 原版版本 JSON（含下载地址），缓存到 meta/versions/<id>.json。 */
export async function getVanillaJson(mcVersion: string): Promise<any> {
  const cached = vanillaCache.get(mcVersion);
  if (cached) return cached;

  const fromDisk = await readJsonFile(vanillaPath(mcVersion));
  if (fromDisk && fromDisk.id) {
    vanillaCache.set(mcVersion, fromDisk);
    return fromDisk;
  }

  const manifest = await loadManifest(false);
  const entry = manifest.versions.find((item) => item.id === mcVersion);
  if (!entry || !entry.url) throw new Error(mt("manifest.noVersion", { version: mcVersion }));

  const json = await fetchMetadata<any>(entry.url, mt("manifest.labelVersionJson", { version: mcVersion }));
  if (!json || !json.id) throw new Error(mt("manifest.parseFailed", { version: mcVersion }));
  vanillaCache.set(mcVersion, json);
  await writeJsonFile(vanillaPath(mcVersion), json);
  log.info(`已缓存 ${mcVersion} 的版本 JSON`);
  return json;
}

/**
 * 去重键 = group:artifact:classifier（忽略 version）。
 * 忽略 version 才能让父级旧版本（如 asm 9.6）在加载器自带新版本（asm 9.10.1）时被丢弃，
 * 否则同一个类会出现在两个 jar 里，Fabric 直接拒绝启动；
 * 带 classifier 才能保住 natives-windows / -arm64 / -linux 这些变体。
 */
function libraryKey(lib: any): string {
  const name = String(lib?.name ?? "").split("@")[0];
  const parts = name.split(":");
  if (parts.length < 2) return name;
  return `${parts[0]}:${parts[1]}:${parts[3] ?? ""}`;
}

/** 加载器 JSON 只写差异，父级提供 libraries/assets/mainClass 以外的公共字段。 */
function mergeVersionJson(child: any, parent: any): any {
  const childLibs: any[] = Array.isArray(child.libraries) ? child.libraries : [];
  const parentLibs: any[] = Array.isArray(parent.libraries) ? parent.libraries : [];
  // 子级排前面：同 group:artifact:classifier 时子级（加载器）版本胜出，父级同键条目丢弃
  const libraries: any[] = [];
  const libraryKeys = new Set<string>();
  for (const lib of [...childLibs, ...parentLibs]) {
    const key = libraryKey(lib);
    if (libraryKeys.has(key)) continue;
    libraryKeys.add(key);
    libraries.push(lib);
  }

  const childArgs = child.arguments ?? {};
  const parentArgs = parent.arguments ?? {};
  const hasArguments = Boolean(child.arguments || parent.arguments);

  const jvm: any[] = Array.isArray(childArgs.jvm) ? [...childArgs.jvm] : [];
  const jvmSeen = new Set(jvm.filter((entry) => typeof entry === "string").map((entry) => String(entry)));
  for (const entry of Array.isArray(parentArgs.jvm) ? parentArgs.jvm : []) {
    // 重复的 -cp 会让 JVM 取到父级 classpath，合并时去重
    if (typeof entry === "string" && jvmSeen.has(entry)) continue;
    jvm.push(entry);
  }
  const game: any[] = [...(Array.isArray(childArgs.game) ? childArgs.game : []), ...(Array.isArray(parentArgs.game) ? parentArgs.game : [])];
  const minecraftArguments = [child.minecraftArguments, parent.minecraftArguments]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ");

  const merged: any = {
    ...parent,
    ...child,
    id: child.id ?? parent.id,
    mainClass: child.mainClass ?? parent.mainClass,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: { ...(parent.downloads ?? {}), ...(child.downloads ?? {}) },
    javaVersion: child.javaVersion ?? parent.javaVersion,
    logging: child.logging ?? parent.logging,
    type: child.type ?? parent.type,
    releaseTime: child.releaseTime ?? parent.releaseTime,
    libraries,
  };
  if (hasArguments) merged.arguments = { game, jvm };
  else delete merged.arguments;
  if (minecraftArguments.length > 0) merged.minecraftArguments = minecraftArguments;
  delete merged.inheritsFrom;
  return merged;
}

export async function getVersionJson(versionId: string): Promise<any> {
  const cached = mergedCache.get(versionId);
  if (cached) return cached;

  const raw = await loadRawVersionJson(versionId);
  if (!raw) throw new Error(mt("manifest.notFound", { version: versionId }));

  const merged = raw.inheritsFrom ? mergeVersionJson(raw, await getVersionJson(String(raw.inheritsFrom))) : raw;
  mergedCache.set(versionId, merged);
  return merged;
}

/** 沿 inheritsFrom 找到最终的原版 id：客户端 jar 与 natives 都落在这个目录。 */
/** 清空内存缓存：安装器改写了版本 JSON 之后需要重新读取。 */
export function clearVersionCache(versionId?: string): void {
  if (versionId) {
    mergedCache.delete(versionId);
    vanillaCache.delete(versionId);
    return;
  }
  mergedCache.clear();
  vanillaCache.clear();
  manifestCache = null;
}

export async function resolveBaseVersionId(versionId: string): Promise<string> {
  let current = versionId;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(current)) throw new Error(mt("manifest.inheritCycle", { version: versionId }));
    visited.add(current);
    const raw = await loadRawVersionJson(current);
    if (!raw) return current;
    const parent = raw.inheritsFrom;
    if (!parent) return current;
    current = String(parent);
  }
}
