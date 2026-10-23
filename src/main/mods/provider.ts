// 两个提供方共用的接口与排序规则；index.ts 只依赖这里，不关心具体来源的字段差异。
import type { LoaderKind, ModContentKind, ModFileInfo, ModProviderId, ModSearchResult } from "../../shared/types";
import type { ModFilesRequest, ModSearchRequest } from "../../shared/ipc";
import { fetchJson } from "../core/http";
import { mt } from "../core/i18n";

/** 来源给出的依赖项（原始形态）：只保留必需关系；名称与安装状态由 dependencies.ts 统一补。 */
export interface RawDependency {
  /** 依赖的项目 id（Modrinth project_id / CurseForge modId）。 */
  projectId: string;
  /** 来源指定的版本 id（Modrinth dependency.version_id）；空表示没有指定。 */
  versionId?: string;
}

/** 项目级信息：文件名模板的 {name} / {slug} 要用它，反查时也能判断归属。 */
export interface ModProjectInfo {
  title: string;
  slug: string;
}

/** 提供方解析出的文件：sha1 可选（部分文件没有公布哈希，例如无 Key 模式的 CurseForge），供下载校验。 */
export interface ResolvedFile {
  info: ModFileInfo;
  /** 规范项目 id（Modrinth project_id / CurseForge modId）：安装索引按它判重，slug 与 id 混用时也不会认错。 */
  projectId?: string;
  sha1?: string;
  /** 公布的文件字节数：没有 sha1 时用它在下载后校验完整性与复用判断。 */
  size?: number;
  /** 项目标题与 slug；查不到时留空，绝不因为模板需求而让安装失败。 */
  project?: ModProjectInfo;
}

/** Modrinth 与 CurseForge 共用的统一接口。 */
export interface ModProvider {
  readonly id: ModProviderId;
  readonly label: string;
  search(req: ModSearchRequest): Promise<ModSearchResult[]>;
  listFiles(req: ModFilesRequest): Promise<ModFileInfo[]>;
  getFile(projectId: string, fileId: string): Promise<ResolvedFile>;
  /** 该文件声明的必需前置；来源拿不到依赖信息（例如无 Key 的 CurseForge）时返回空数组。 */
  getDependencies?(projectId: string, fileId: string): Promise<RawDependency[]>;
  /** 项目标题与 slug（带进程内缓存）；来源不支持或查询失败时返回 undefined。 */
  getProject?(projectId: string): Promise<ModProjectInfo | undefined>;
  /**
   * 项目的内容类型：依赖行要靠它决定落 mods 还是 resourcepacks/shaderpacks。
   * 来源不支持或查询失败时返回 undefined，调用方按 "mod" 兜底。
   */
  getProjectType?(projectId: string): Promise<ModContentKind | undefined>;
  /** 提供方原始条目 → 统一模型，kind 决定目标类型。 */
  normalize(kind: "search", raw: unknown): ModSearchResult;
  normalize(kind: "file", raw: unknown): ModFileInfo;
}

/** 按内容反查的结果：所属项目 + 命中的版本文件。 */
export interface Sha1Lookup {
  projectId: string;
  file: ModFileInfo;
}

/** 反查所需的本地文件：path 用于算指纹，sha1 用于按哈希查询。 */
export interface ModBacklookFile {
  path: string;
  sha1: string;
}

/** 按内容反查来源：Modrinth 用 sha1，CurseForge 用 murmur2 指纹。 */
export interface ModBacklook {
  readonly provider: ModProviderId;
  /** 未收录返回 undefined（不是错误）。 */
  lookup(file: ModBacklookFile): Promise<Sha1Lookup | undefined>;
  /** 一次查完的来源实现它，省请求；key 为 sha1。 */
  lookupBatch?(files: ModBacklookFile[]): Promise<Map<string, Sha1Lookup>>;
}

/** 项目信息缓存：成功长期有效，失败只挡 5 分钟，避免每次安装都重试一次网络。 */
const projectCache = new Map<ModProviderId, Map<string, { value: ModProjectInfo | null; at: number }>>();
const PROJECT_FAILURE_TTL_MS = 5 * 60_000;

/** 同一个项目在一次运行里最多查一次：模板要标题，但安装主流程不该为它反复付网络成本。 */
export async function cachedProject(
  providerId: ModProviderId,
  projectId: string,
  load: () => Promise<ModProjectInfo | undefined>,
): Promise<ModProjectInfo | undefined> {
  if (!projectId) return undefined;
  let byProject = projectCache.get(providerId);
  if (!byProject) {
    byProject = new Map();
    projectCache.set(providerId, byProject);
  }
  const hit = byProject.get(projectId);
  if (hit && (hit.value !== null || Date.now() - hit.at < PROJECT_FAILURE_TTL_MS)) {
    return hit.value ?? undefined;
  }

  try {
    const value = await load();
    byProject.set(projectId, { value: value ?? null, at: Date.now() });
    return value;
  } catch {
    // 查询失败只影响文件名模板（回退远端名），不能拖垮安装
    byProject.set(projectId, { value: null, at: Date.now() });
    return undefined;
  }
}

/** 诊断用：清空项目缓存（自检脚本统计真实请求次数时需要）。 */
export function clearProjectCache(): void {
  projectCache.clear();
}

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const FILE_LIMIT_DEFAULT = 50;
export const FILE_LIMIT_MAX = 200;

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HTTP 状态码：core/http 抛的 HttpError 带 status，包装过的错误只能从文案里取。 */
export function httpStatusOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  const matched = /HTTP (\d{3})\b/.exec(messageOf(err));
  return matched ? Number(matched[1]) : null;
}

/** 并发闸门：来源 API 有速率限制，逐条太慢、全并发容易被限流。 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const slots = Math.max(1, Math.min(Math.trunc(limit), items.length));
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return results;
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.trunc(value), max);
}

// ---------- 原始 JSON 取值（API 字段随时可能缺，统一兜底） ----------

export function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function jsonString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function jsonNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function jsonStringArray(value: unknown): string[] {
  return jsonArray(value).filter((v): v is string => typeof v === "string");
}

/** id 在两个来源里可能是数字或字符串，统一成字符串。 */
export function jsonIdString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return jsonString(value);
}

export function toReleaseType(value: unknown): ModFileInfo["releaseType"] {
  return value === "beta" || value === "alpha" ? value : "release";
}

// ---------- 加载器映射 ----------

/**
 * 加载器只对模组与整合包有意义：光影条目带的是 iris/optifine，资源包带的是 minecraft，
 * 用实例加载器去筛只会把可用结果筛空（或排到最后），所以这两类不做加载器约束。
 */
export function loaderAppliesTo(kind: ModContentKind): boolean {
  return kind === "mod" || kind === "modpack";
}

/** LoaderKind → 提供方的 loader 标签；vanilla 没有加载器，因此不产生约束。 */
export function loaderTags(loader?: LoaderKind): string[] {
  switch (loader) {
    case "fabric":
      return ["fabric"];
    case "forge":
      return ["forge"];
    case "neoforge":
      return ["neoforge"];
    default:
      return [];
  }
}

const LOADER_ALIASES: Record<string, string> = {
  fabric: "fabric",
  quilt: "quilt",
  forge: "forge",
  neoforge: "neoforge",
  "neo-forge": "neoforge",
  "neo forge": "neoforge",
  liteloader: "liteloader",
  rift: "rift",
};

/** 把 "NeoForge" / "neo forge" 之类写法归一成 LoaderKind 的小写标签。 */
export function canonicalLoader(raw: string): string {
  const key = raw.trim().toLowerCase();
  return LOADER_ALIASES[key] ?? key;
}

// ---------- 版本匹配优先级 ----------

/**
 * 0 完全匹配（版本严格相等 + loader），1 同系列（major.minor 相同 + loader），
 * 2 仅 loader，3 仅版本，4 都不匹配。数值越小越优先。
 */
export type MatchTier = 0 | 1 | 2 | 3 | 4;

/** 版本匹配强度：2 严格相等，1 同系列（major.minor 相同），0 不匹配。 */
type VersionStrength = 0 | 1 | 2;

/** 只比 major.minor：1.21、1.21.3 对实例 1.21.4 都算同系列。 */
export function sameSeries(a: string, b: string): boolean {
  const left = /^(\d+)\.(\d+)/.exec(a.trim());
  const right = /^(\d+)\.(\d+)/.exec(b.trim());
  if (!left || !right) return false;
  return left[1] === right[1] && left[2] === right[2];
}

/**
 * 只看版本的档位：0 同版本、1 同系列、2 不匹配。光影/资源包没有加载器概念，
 * 它们的匹配与更新候选只能按这个口径判定。
 */
export function versionOnlyTier(file: ModFileInfo, gameVersion?: string): MatchTier {
  // 调用方不限定版本时不做版本约束
  if (!gameVersion) return 0;
  const target = gameVersion.trim();
  if (file.gameVersions.some((v) => v.trim() === target)) return 0;
  if (file.gameVersions.some((v) => sameSeries(v, target))) return 1;
  return 2;
}

function versionStrength(file: ModFileInfo, gameVersion?: string): VersionStrength {
  return (2 - versionOnlyTier(file, gameVersion)) as VersionStrength;
}

function loaderMatched(file: ModFileInfo, loader?: LoaderKind): boolean {
  const tags = loaderTags(loader);
  // 原版实例没有加载器：只有不带加载器的文件才算匹配，避免把 fabric 模组当“完全匹配”。
  if (tags.length === 0) return file.loaders.length === 0;
  return file.loaders.some((l) => tags.includes(canonicalLoader(l)));
}

export function matchTier(file: ModFileInfo, gameVersion?: string, loader?: LoaderKind): MatchTier {
  const strength = versionStrength(file, gameVersion);
  const byLoader = loaderMatched(file, loader);
  if (byLoader) {
    if (strength === 2) return 0;
    if (strength === 1) return 1;
    return 2;
  }
  // loader 不符时严格同版本与同系列都只算「仅版本匹配」：loader 比版本更关键，排在 loader 匹配之后
  return strength > 0 ? 3 : 4;
}

function publishedAtMs(file: ModFileInfo): number {
  const t = Date.parse(file.publishedAt);
  return Number.isFinite(t) ? t : 0;
}

/** 按匹配档位重排，并如实写入 exactMatch；同档按发布时间倒序。 */
export function rankFiles(files: ModFileInfo[], gameVersion?: string, loader?: LoaderKind): ModFileInfo[] {
  return files
    .map((file) => ({ file, tier: matchTier(file, gameVersion, loader) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const byTime = publishedAtMs(b.file) - publishedAtMs(a.file);
      if (byTime !== 0) return byTime;
      return a.file.fileName.localeCompare(b.file.fileName);
    })
    .map(({ file, tier }) => ({ ...file, exactMatch: tier === 0 }));
}

/** 未指定 fileId 时取最优档里最新的那个文件。 */
export function bestFile(files: ModFileInfo[], gameVersion?: string, loader?: LoaderKind): ModFileInfo | undefined {
  return rankFiles(files, gameVersion, loader)[0];
}

// ---------- API JSON 请求 ----------

/**
 * 统一走 core/http 的 fetchJson：它默认发 User-Agent: NaiWaLauncher/0.1 (naiwa)（Modrinth 要求）并合并
 * 调用方 headers（CurseForge 的 x-api-key），还自带重试与超时。这里只补中文错误包装；
 * API 域名不走镜像，大文件下载仍由 downloadFile 负责。
 */
export async function apiJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  try {
    return await fetchJson<T>(url, {
      allowMirror: false,
      timeoutMs: opts.timeoutMs ?? 15000,
      retries: opts.retries ?? 3,
      headers: opts.headers,
    });
  } catch (err) {
    const status = httpStatusOf(err);
    const wrapped = new Error(mt("mods.requestFailed", { error: messageOf(err) })) as Error & { status?: number };
    // 保留状态码：调用方要区分「未收录(404)」与真正的故障
    if (status !== null) wrapped.status = status;
    throw wrapped;
  }
}
