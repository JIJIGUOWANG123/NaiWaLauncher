// CurseForge 数据源有两条完全等价的 v1 通道：填了 Key 走官方 api.curseforge.com，没填 Key 走
// MCIM 社区镜像 mod.mcimirror.top（CurseForge v1 兼容、免 Key）。两者响应结构一致，所以这里只在
// base/headers 一处做分支，字段映射、排序、下载链路全部共用；镜像故障另有可读文案，不会提示用户填 Key。
import { readFile } from "node:fs/promises";
import type { LoaderKind, ModContentKind, ModFileInfo, ModSearchResult } from "../../shared/types";
import type { ModFilesRequest, ModSearchRequest } from "../../shared/ipc";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import {
  apiJson, cachedProject, canonicalLoader, clampLimit, httpStatusOf, jsonArray, jsonIdString, jsonNumber, jsonObject,
  jsonString, jsonStringArray, messageOf, type ModBacklook, type ModBacklookFile, type ModProjectInfo,
  type ModProvider, type RawDependency, type ResolvedFile, type Sha1Lookup,
  SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, FILE_LIMIT_DEFAULT, FILE_LIMIT_MAX,
} from "./provider";

import { mt } from "../core/i18n";

const log = logger("mods");

/** 官方 v1 接口：需要 x-api-key。 */
const OFFICIAL_BASE = "https://api.curseforge.com/v1";
/** MCIM 社区镜像的 CurseForge v1 兼容端点：免 Key，响应结构与官方一致。 */
const MIRROR_BASE = "https://mod.mcimirror.top/curseforge/v1";
const GAME_ID_MINECRAFT = 432;
const CLASS_ID_MODS = 6;

/** 当前数据源：填了 Key 走官方（保留原有行为），没填走社区镜像。 */
interface CfEndpoint {
  base: string;
  headers: Record<string, string>;
  /** True = 镜像（不带 Key，错误文案按镜像翻译）。 */
  mirror: boolean;
}

function endpoint(): CfEndpoint {
  const key = getSettings().curseforgeApiKey;
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (trimmed) {
    return { base: OFFICIAL_BASE, headers: { "x-api-key": trimmed, Accept: "application/json" }, mirror: false };
  }
  // 镜像不认 x-api-key，带上反而可能被拒
  return { base: MIRROR_BASE, headers: { Accept: "application/json" }, mirror: true };
}

const SORT_FIELD: Record<NonNullable<ModSearchRequest["sort"]>, number> = {
  relevance: 1,
  downloads: 6,
  updated: 3,
};

/** CurseForge 的 modLoaderType：1=Forge，4=Fabric，6=NeoForge。 */
function modLoaderType(loader?: LoaderKind): number | undefined {
  switch (loader) {
    case "forge":
      return 1;
    case "fabric":
      return 4;
    case "neoforge":
      return 6;
    default:
      return undefined;
  }
}

/** 无 Key 时的镜像同样支持关键词搜索，所以 CurseForge 永远是聚合搜索里的一员。 */
export function curseforgeSearchAvailable(): boolean {
  return true;
}

function keyRejectedMessage(): string {
  return mt("mods.keyRejected");
}

/** 镜像侧故障（5xx/超时/限流）：翻译成用户能行动的提示，绝不显示「请填写 API Key」。 */
function mirrorFailed(err: unknown): Error {
  const status = httpStatusOf(err);
  return new Error(mt("mods.mirrorFailed", { error: status === null ? messageOf(err) : `HTTP ${status}` }));
}

/**
 * 官方 401/403 只可能是 key 被拒，换成用户看得懂的话（保留状态码，不透出 core/http 附带的长 URL）；
 * 镜像不需要 Key，只有链路故障才改写文案，404 之类的语义错误原样上抛（调用方要区分「未收录」）。
 */
async function requestJson<T>(url: string, source: CfEndpoint): Promise<T> {
  try {
    return await apiJson<T>(url, { headers: source.headers });
  } catch (err) {
    const status = httpStatusOf(err);
    if (source.mirror) {
      if (status === null || status === 429 || status >= 500) throw mirrorFailed(err);
      throw err;
    }
    if (status === 401 || status === 403) throw new Error(`${keyRejectedMessage()}（HTTP ${status}）`);
    throw err;
  }
}

/** 按当前数据源拼路径发请求：官方带 x-api-key，镜像不带。 */
async function cfJson<T>(path: string, params?: URLSearchParams): Promise<T> {
  const source = endpoint();
  const query = params && params.toString() ? `?${params.toString()}` : "";
  return requestJson<T>(`${source.base}${path}${query}`, source);
}

const KNOWN_LOADER_TAGS = new Set(["forge", "neoforge", "fabric", "quilt", "liteloader", "rift"]);

/** CurseForge 把 MC 版本和加载器混在 gameVersions 里（如 ["1.21.4","Fabric"]），必须拆开。 */
export function splitGameVersions(values: string[]): { gameVersions: string[]; loaders: string[] } {
  const gameVersions: string[] = [];
  const loaders: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (/^\d+\.\d+(\.\d+)?$/.test(trimmed)) gameVersions.push(trimmed);
    else if (KNOWN_LOADER_TAGS.has(trimmed.toLowerCase())) loaders.push(canonicalLoader(trimmed));
  }
  return { gameVersions, loaders };
}

function toReleaseType(code: number): ModFileInfo["releaseType"] {
  if (code === 2) return "beta";
  if (code === 3) return "alpha";
  return "release";
}

function toSearchResult(raw: unknown): ModSearchResult {
  const mod = jsonObject(raw);
  const logo = jsonObject(mod.logo);
  const authors = jsonArray(mod.authors).map(jsonObject);
  const iconUrl = jsonString(logo.thumbnailUrl) || jsonString(logo.url);
  const categories = jsonArray(mod.categories).map(jsonObject).map((c) => jsonString(c.name)).filter((n) => n !== "");
  return {
    provider: "curseforge",
    projectId: jsonIdString(mod.id) || jsonString(mod.slug),
    slug: jsonString(mod.slug),
    title: jsonString(mod.name),
    description: jsonString(mod.summary),
    author: jsonString(authors[0]?.name),
    downloads: jsonNumber(mod.downloadCount),
    iconUrl: iconUrl || undefined,
    categories,
  };
}

function toFileInfo(raw: unknown): ModFileInfo {
  const file = jsonObject(raw);
  const { gameVersions, loaders } = splitGameVersions(jsonStringArray(file.gameVersions));
  return {
    provider: "curseforge",
    fileId: jsonIdString(file.id),
    name: jsonString(file.displayName) || jsonString(file.fileName),
    fileName: jsonString(file.fileName),
    downloadUrl: jsonString(file.downloadUrl),
    gameVersions,
    loaders,
    exactMatch: false,
    releaseType: toReleaseType(jsonNumber(file.releaseType)),
    downloads: jsonNumber(file.downloadCount),
    publishedAt: jsonString(file.fileDate),
  };
}

/** CurseForge 的 hashes 里 algo 1 是 sha1。 */
function sha1Of(raw: unknown): string | undefined {
  const hashes = jsonArray(jsonObject(raw).hashes).map(jsonObject);
  const sha1 = hashes.find((h) => jsonNumber(h.algo) === 1);
  const value = sha1 ? jsonString(sha1.value) : "";
  return value || undefined;
}

/** 用户直接粘贴链接或纯数字 id 时按项目精确解析，其余当关键词交给 search 端点。 */
function directProjectKey(query: string): string {
  const raw = query.trim();
  const fromUrl = /curseforge\.com\/minecraft\/[a-z-]+\/([^/?#\s]+)/i.exec(raw)?.[1];
  if (fromUrl) return fromUrl;
  return /^\d+$/.test(raw) ? raw : "";
}

/** 单个项目（id 或 slug 都行）：搜索精确解析、项目名与类型查询共用。 */
async function fetchMod(projectId: string): Promise<Record<string, unknown>> {
  const body = await cfJson<Record<string, unknown>>(`/mods/${encodeURIComponent(projectId)}`);
  return jsonObject(body.data);
}

async function search(req: ModSearchRequest): Promise<ModSearchResult[]> {
  const query = String(req.query ?? "").trim();
  const direct = directProjectKey(query);
  if (direct) return [toSearchResult(await fetchMod(direct))];

  const params = new URLSearchParams({
    gameId: String(GAME_ID_MINECRAFT),
    classId: String(CLASS_ID_MODS),
    searchFilter: query,
    index: String(Math.max(0, Math.trunc(req.offset ?? 0))),
    pageSize: String(clampLimit(req.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX)),
    // 镜像不认缺省排序（会返回毫不相关的结果），sortField 必须显式给
    sortField: String(SORT_FIELD[req.sort ?? "relevance"]),
    sortOrder: "desc",
  });
  if (req.gameVersion) params.set("gameVersion", req.gameVersion);
  const loaderType = modLoaderType(req.loader);
  if (loaderType !== undefined) params.set("modLoaderType", String(loaderType));

  const body = await cfJson<Record<string, unknown>>("/mods/search", params);
  return jsonArray(body.data).map(toSearchResult);
}

async function listFiles(req: ModFilesRequest): Promise<ModFileInfo[]> {
  const limit = clampLimit(req.limit, FILE_LIMIT_DEFAULT, FILE_LIMIT_MAX);
  const params = new URLSearchParams({ pageSize: String(limit) });
  if (req.gameVersion) params.set("gameVersion", req.gameVersion);
  const loaderType = modLoaderType(req.loader);
  if (loaderType !== undefined) params.set("modLoaderType", String(loaderType));

  const body = await cfJson<Record<string, unknown>>(`/mods/${encodeURIComponent(req.projectId)}/files`, params);
  // 五档排序在 index.listModFiles 里统一做，这里只取够数量；没有 downloadUrl 的条目（作者禁止第三方分发）
  // 两条通道都给不出可下载地址，直接丢掉，免得到安装那一步才失败
  return jsonArray(body.data).map(toFileInfo).filter((f) => f.downloadUrl !== "").slice(0, limit);
}

/** 项目标题与 slug：文件名模板要用；查询失败返回 undefined，不影响安装。 */
async function getProject(projectId: string): Promise<ModProjectInfo | undefined> {
  return cachedProject("curseforge", projectId, async () => {
    const mod = await fetchMod(projectId);
    const title = jsonString(mod.name);
    if (!title) return undefined;
    return { title, slug: jsonString(mod.slug) || projectId };
  });
}

/** CurseForge 的 classId → 内容类型（6 模组 / 12 资源包 / 4471 整合包 / 6552 光影）。 */
const CLASS_ID_KIND: Record<number, ModContentKind> = {
  6: "mod",
  12: "resourcepack",
  4471: "modpack",
  6552: "shader",
};

/**
 * 依赖行要按项目类型落目录。请求失败时返回 undefined：调用方按模组兜底，
 * 绝不为了一个类型字段让安装失败。
 */
async function getProjectType(projectId: string): Promise<ModContentKind | undefined> {
  try {
    const mod = await fetchMod(projectId);
    return CLASS_ID_KIND[jsonNumber(mod.classId)];
  } catch (err) {
    log.warn(`CurseForge 项目类型查询失败，按模组处理：${projectId} · ${messageOf(err)}`);
    return undefined;
  }
}

/** 文件对象没带 downloadUrl 时单独问一次 download-url 端点；作者禁止第三方分发时这里也是空的。 */
async function downloadUrlOf(projectId: string, fileId: string): Promise<string> {
  try {
    const body = await cfJson<Record<string, unknown>>(
      `/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download-url`,
    );
    return typeof body.data === "string" ? body.data.trim() : "";
  } catch (err) {
    log.warn(`CurseForge 下载地址查询失败：${projectId}/${fileId} · ${messageOf(err)}`);
    return "";
  }
}

async function getFile(projectId: string, fileId: string): Promise<ResolvedFile> {
  const path = `/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`;
  const data = jsonObject((await cfJson<Record<string, unknown>>(path)).data);
  const info = toFileInfo(data);
  // downloadUrl 优先取文件对象里的直链，空了再问 download-url 端点
  if (!info.downloadUrl) info.downloadUrl = await downloadUrlOf(projectId, fileId);
  if (!info.downloadUrl) {
    throw new Error(mt("mods.cfThirdPartyBlocked", { file: fileId }));
  }
  // file.modId 才是规范项目 id：调用方可能传 slug
  const owner = jsonIdString(data.modId);
  const size = jsonNumber(data.fileLength);
  return {
    info,
    projectId: owner || undefined,
    sha1: sha1Of(data),
    // 字节数：sha1 缺失时用它校验完整性，已有文件复用判定也用得上
    size: size > 0 ? size : undefined,
    project: await getProject(projectId),
  };
}

// ---------- 前置依赖 ----------

/** CurseForge 的 FileRelationType：3 = RequiredDependency，其余（1 嵌入 / 2 可选 / 4 工具 / 5 不兼容…）都不装。 */
const REQUIRED_DEPENDENCY = 3;

/** 文件对象的 dependencies[] → 必需前置。同官方枚举过滤，并按 modId 去重。 */
export function requiredDependencies(raw: unknown): RawDependency[] {
  const seen = new Set<string>();
  const out: RawDependency[] = [];
  for (const entry of jsonArray(jsonObject(raw).dependencies).map(jsonObject)) {
    if (jsonNumber(entry.relationType) !== REQUIRED_DEPENDENCY) continue;
    const projectId = jsonIdString(entry.modId);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    out.push({ projectId });
  }
  return out;
}

/**
 * 某个文件的必需前置。官方与镜像的 `/mods/{id}/files/{fileId}` 都把 dependencies[] 放在文件对象上，
 * 所以两条通道都能解析；查询失败只记 warn 返回空数组——少装一个前置好过让本体安装整块失败。
 */
async function getDependencies(projectId: string, fileId: string): Promise<RawDependency[]> {
  try {
    const body = await cfJson<Record<string, unknown>>(
      `/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
    );
    return requiredDependencies(jsonObject(body.data));
  } catch (err) {
    log.warn(`CurseForge 依赖查询失败，按无前置处理：${projectId}/${fileId} · ${messageOf(err)}`);
    return [];
  }
}

// ---------- 指纹反查（CurseForge 独有的按内容查询方式） ----------

/** 空白字节在指纹计算前必须剔除，否则同一个文件在不同打包工具的产物里对不上。 */
function fingerprintBytes(data: Buffer): Buffer {
  const bytes = Buffer.allocUnsafe(data.length);
  let length = 0;
  for (const byte of data) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue;
    bytes[length] = byte;
    length += 1;
  }
  return bytes.subarray(0, length);
}

/**
 * MurmurHash2（32 位，4 字节小端分块），长度参与初始哈希，结果是有符号 int32。
 * 位运算全部用 >>>（逻辑右移）：参考实现里是无符号 u32，用 >> 会被符号位带偏。
 * 单独导出，便于用公开测试向量校验实现。
 */
export function murmur2(bytes: Buffer, seed: number): number {
  const length = bytes.length;
  const m = 0x5bd1e995;
  const r = 24;
  let h = (seed ^ length) >>> 0;

  const blocks = length >>> 2;
  for (let index = 0; index < blocks; index += 1) {
    const at = index * 4;
    let k = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
    k = Math.imul(k, m);
    k ^= k >>> r;
    k = Math.imul(k, m);
    h = Math.imul(h, m);
    h ^= k;
  }

  const tail = length & ~3;
  const extra = length & 3;
  if (extra >= 3) h ^= bytes[tail + 2] << 16;
  if (extra >= 2) h ^= bytes[tail + 1] << 8;
  if (extra >= 1) {
    h ^= bytes[tail];
    h = Math.imul(h, m);
  }
  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h | 0;
}

/** CurseForge 标准指纹：剔除空白字节后按 seed 1 计算 murmur2。 */
export function curseforgeFingerprint(data: Buffer): number {
  return murmur2(fingerprintBytes(data), 1);
}

/** core/http 只有 GET 辅助；指纹反查必须 POST，且是小 JSON 请求，不需要多线程。 */
async function postJson<T>(url: string, body: unknown, source: CfEndpoint): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "user-agent": "NaiWaLauncher/0.1 (naiwa)",
          "content-type": "application/json",
          accept: "application/json",
          ...source.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} · ${url}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return JSON.parse(text) as T;
    } catch (err) {
      lastError = err;
      const status = httpStatusOf(err);
      const retryable = status === null || status === 429 || status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  const status = httpStatusOf(lastError);
  if (source.mirror) {
    if (status === null || status === 429 || status >= 500) throw mirrorFailed(lastError);
  } else if (status === 401 || status === 403) {
    throw new Error(`${keyRejectedMessage()}（HTTP ${status}）`);
  }
  throw new Error(mt("mods.fingerprintFailed", { error: messageOf(lastError) }));
}

/** 一次 POST 查完全部指纹（官方与镜像都有 /fingerprints），命中项再按 modId 反查项目最佳文件。 */
async function lookupByFingerprint(files: ModBacklookFile[]): Promise<Map<string, Sha1Lookup>> {
  const out = new Map<string, Sha1Lookup>();
  if (files.length === 0) return out;
  const source = endpoint();

  const byFingerprint = new Map<number, string>();
  for (const file of files) {
    try {
      byFingerprint.set(curseforgeFingerprint(await readFile(file.path)), file.sha1);
    } catch (err) {
      log.warn(`无法读取模组文件计算指纹：${file.path} · ${messageOf(err)}`);
    }
  }
  if (byFingerprint.size === 0) return out;

  const body = await postJson<Record<string, unknown>>(
    `${source.base}/fingerprints`,
    { fingerprints: [...byFingerprint.keys()] },
    source,
  );
  for (const raw of jsonArray(jsonObject(body.data).exactMatches)) {
    const match = jsonObject(raw);
    const fileRaw = jsonObject(match.file);
    const info = toFileInfo(fileRaw);
    if (!info.fileId) continue;
    // 单文件查询时服务端不一定回传 fileFingerprint，按唯一输入兜底
    const sha1 = byFingerprint.get(jsonNumber(fileRaw.fileFingerprint))
      ?? (byFingerprint.size === 1 ? [...byFingerprint.values()][0] : undefined);
    if (!sha1) continue;
    const projectId = jsonIdString(fileRaw.modId) || jsonIdString(match.id) || jsonIdString(jsonObject(raw).id);
    if (!projectId) continue;
    out.set(sha1, { projectId, file: info });
  }
  return out;
}

export const curseforgeBacklook: ModBacklook = {
  provider: "curseforge",
  async lookup(file: ModBacklookFile): Promise<Sha1Lookup | undefined> {
    return (await lookupByFingerprint([file])).get(file.sha1);
  },
  lookupBatch: lookupByFingerprint,
};

export function normalize(kind: "search", raw: unknown): ModSearchResult;
export function normalize(kind: "file", raw: unknown): ModFileInfo;
export function normalize(kind: "search" | "file", raw: unknown): ModSearchResult | ModFileInfo {
  return kind === "search" ? toSearchResult(raw) : toFileInfo(raw);
}

export const curseforgeProvider: ModProvider = {
  id: "curseforge",
  label: "CurseForge",
  search,
  listFiles,
  getFile,
  getDependencies,
  getProject,
  getProjectType,
  normalize,
};
