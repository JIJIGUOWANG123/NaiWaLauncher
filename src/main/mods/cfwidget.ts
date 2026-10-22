// CurseForge 没有 API Key 时的只读数据源：cfwidget 社区镜像（没有搜索端点，只能按 id/slug 解析），
// 文件下载走 forgecdn 直链（项目接口不给哈希，下载后按文件大小校验）。
import type { LoaderKind, ModFileInfo, ModSearchResult } from "../../shared/types";
import { fetchJson } from "../core/http";
import { logger } from "../core/logger";
import {
  canonicalLoader, httpStatusOf, jsonArray, jsonIdString, jsonNumber, jsonObject, jsonString, jsonStringArray,
  loaderTags, messageOf, sameSeries,
} from "./provider";

const log = logger("mods");

const BASE = "https://api.cfwidget.com/minecraft/mc-mods";
const CDN_BASE = "https://mediafilez.forgecdn.net/files";
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;

export const NO_KEY_SEARCH_MESSAGE =
  "无 Key 模式下 CurseForge 不支持关键词搜索，请粘贴模组链接（curseforge.com/minecraft/mc-mods/xxx）或到设置填写 API Key";

const LOADER_TAGS = new Set(["fabric", "forge", "neoforge", "quilt", "liteloader", "rift"]);

/** cfwidget 的一个文件条目（files[]）。 */
export interface CfWidgetFile {
  id: number;
  name: string;
  display: string;
  type: string;
  filesize: number;
  versions: string[];
  uploadedAt: string;
  downloads: number;
}

/** cfwidget 的一个项目（响应顶层）。 */
export interface CfWidgetProject {
  id: string;
  title: string;
  slug: string;
  summary: string;
  author: string;
  downloads: number;
  iconUrl?: string;
  files: CfWidgetFile[];
  /** 详情页用：cfwidget 给的介绍是 HTML 原文，没有介绍时为空。 */
  description: string;
  categories: string[];
  /** 源码仓库链接；cfwidget 只对部分项目提供，没有就留空。 */
  sourceUrl: string;
}

/** cfwidget 的链接清单里挑源码仓库：类型形如 source / github / 源码。 */
function sourceUrlOf(project: Record<string, unknown>, urls: Record<string, unknown>): string {
  const direct = jsonString(urls.source) || jsonString(urls.source_code);
  if (direct) return direct;
  for (const entry of jsonArray(project.links).map(jsonObject)) {
    const type = jsonString(entry.type).toLowerCase();
    const url = jsonString(entry.url);
    if (url && /source|github|gitlab|repo/.test(type)) return url;
  }
  return "";
}

function slugOfUrl(url: string): string {
  const matched = /\/minecraft\/mc-mods\/([^/?#]+)/i.exec(url);
  return matched ? matched[1] : "";
}

function toFile(raw: unknown): CfWidgetFile {
  const file = jsonObject(raw);
  const name = jsonString(file.name) || (jsonString(file.display) ? `${jsonString(file.display)}.jar` : "");
  return {
    id: jsonNumber(file.id),
    name,
    display: jsonString(file.display) || name,
    type: jsonString(file.type).toLowerCase(),
    filesize: jsonNumber(file.filesize),
    versions: jsonStringArray(file.versions),
    uploadedAt: jsonString(file.uploaded_at),
    downloads: jsonNumber(file.downloads),
  };
}

function toProject(raw: unknown, key: string): CfWidgetProject {
  const project = jsonObject(raw);
  const urls = jsonObject(project.urls);
  const slug = slugOfUrl(jsonString(urls.curseforge) || jsonString(urls.project)) || (/^\d+$/.test(key) ? "" : key);
  const members = jsonArray(project.members).map(jsonObject);
  const downloads = jsonObject(project.downloads);
  return {
    id: jsonIdString(project.id) || key,
    title: jsonString(project.title) || slug || key,
    slug: slug || key,
    summary: jsonString(project.summary),
    author: jsonString(members[0]?.username),
    downloads: jsonNumber(downloads.total) || jsonNumber(downloads.monthly),
    iconUrl: jsonString(project.thumbnail) || undefined,
    // 没有文件大小或文件名的条目构造不出下载地址，直接丢掉
    files: jsonArray(project.files).map(toFile).filter((f) => f.id > 0 && f.name !== "" && f.filesize > 0),
    description: jsonString(project.description),
    categories: jsonStringArray(project.categories),
    sourceUrl: sourceUrlOf(project, urls),
  };
}

const cache = new Map<string, { at: number; value: CfWidgetProject }>();

function remember(key: string, value: CfWidgetProject): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value });
}

/** 按 id 或 slug 取项目（5 分钟缓存）：项目元数据、文件列表、下载地址都从这里出。 */
export async function fetchCfWidgetProject(idOrSlug: string): Promise<CfWidgetProject> {
  const key = String(idOrSlug ?? "").trim().toLowerCase();
  if (!key) throw new Error("缺少 CurseForge 项目 id 或 slug");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let body: unknown;
  try {
    body = await fetchJson<unknown>(`${BASE}/${encodeURIComponent(key)}`, { allowMirror: false, timeoutMs: 15000, retries: 2 });
  } catch (err) {
    // 404 说明 cfwidget 没收录；错误文案里只留状态码与 slug，不把 HTML 抛给用户
    const status = httpStatusOf(err);
    if (status === 404) throw new Error(`CurseForge 没有找到模组「${key}」（cfwidget 未收录），请检查链接或 slug`);
    throw new Error(`cfwidget 查询失败（${key}）：${messageOf(err)}`);
  }

  const project = toProject(body, key);
  if (project.files.length === 0) log.warn(`cfwidget 项目 ${project.title} 没有可用文件`);
  remember(key, project);
  return project;
}

/** 清空缓存（自检脚本统计请求次数用）。 */
export function clearCfWidgetCache(): void {
  cache.clear();
}

/** forgecdn 直链规则：/files/<id 除以 1000 补 4 位>/<id 余 1000 补 3 位>/<文件名>。 */
export function cfCdnUrl(fileId: number | string, fileName: string): string {
  const id = Number(fileId);
  if (!Number.isFinite(id) || id <= 0 || !fileName) return "";
  const dir = String(Math.floor(id / 1000)).padStart(4, "0");
  const sub = String(id % 1000).padStart(3, "0");
  return `${CDN_BASE}/${dir}/${sub}/${encodeURIComponent(fileName)}`;
}

/** CurseForge 把 MC 版本和加载器混在 versions 里（如 ["Client","Fabric","1.20.1","Server"]）。 */
function splitVersions(values: string[]): { gameVersions: string[]; loaders: string[] } {
  const gameVersions: string[] = [];
  const loaders: string[] = [];
  for (const value of values) {
    const token = value.trim();
    if (!token) continue;
    const lower = token.toLowerCase();
    if (LOADER_TAGS.has(lower)) {
      loaders.push(canonicalLoader(token));
      continue;
    }
    if (/^\d+(\.\d+)*([a-z]\d*)?$/i.test(token) || /^\d{2}w\d{2}[a-z]$/i.test(token)) gameVersions.push(token);
  }
  return { gameVersions, loaders };
}

function toReleaseType(type: string): ModFileInfo["releaseType"] {
  if (type === "beta") return "beta";
  if (type === "alpha") return "alpha";
  return "release";
}

export function toModFileInfo(file: CfWidgetFile): ModFileInfo {
  const { gameVersions, loaders } = splitVersions(file.versions);
  return {
    provider: "curseforge",
    fileId: String(file.id),
    name: file.display || file.name,
    fileName: file.name,
    downloadUrl: cfCdnUrl(file.id, file.name),
    gameVersions,
    loaders,
    // 目标实例未知，交给 provider.rankFiles 按实例如实置位
    exactMatch: false,
    releaseType: toReleaseType(file.type),
    downloads: file.downloads,
    publishedAt: file.uploadedAt,
  };
}

/** 项目 → 搜索结果（无 Key 模式只能按 id/slug 精确解析出一个项目）。 */
export function toSearchResult(project: CfWidgetProject): ModSearchResult {
  return {
    provider: "curseforge",
    projectId: project.id,
    slug: project.slug,
    title: project.title,
    description: project.summary,
    author: project.author,
    downloads: project.downloads,
    iconUrl: project.iconUrl,
    categories: [],
  };
}

/** 无 Key 模式下按「链接 / 数字 id / slug」解析；关键词拿不到结果，直接给可读错误。 */
export function projectKeyFromQuery(query: string | undefined): string {
  const raw = String(query ?? "").trim();
  const fromUrl = /curseforge\.com\/minecraft\/mc-mods\/([^/?#\s]+)/i.exec(raw)?.[1];
  const candidate = (fromUrl ?? raw).trim();
  if (!candidate) throw new Error(NO_KEY_SEARCH_MESSAGE);
  if (/^\d+$/.test(candidate)) return candidate;
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(candidate)) return candidate.toLowerCase();
  throw new Error(NO_KEY_SEARCH_MESSAGE);
}

function publishedMs(file: ModFileInfo): number {
  const time = Date.parse(file.publishedAt);
  return Number.isFinite(time) ? time : 0;
}

/** 项目 → 目标实例可用的文件：版本按「精确或同系列」、加载器按标签过滤，新的排前面。 */
export function filesFor(
  project: CfWidgetProject,
  opts: { gameVersion?: string; loader?: LoaderKind; limit?: number } = {},
): ModFileInfo[] {
  const tags = loaderTags(opts.loader);
  const target = opts.gameVersion?.trim() ?? "";
  const matched = project.files
    .map(toModFileInfo)
    .filter((file) => file.downloadUrl !== "")
    .filter((file) => tags.length === 0 || file.loaders.some((loader) => tags.includes(canonicalLoader(loader))))
    .filter((file) => !target || file.gameVersions.some((version) => version === target || sameSeries(version, target)));
  matched.sort((a, b) => publishedMs(b) - publishedMs(a));
  return opts.limit && opts.limit > 0 ? matched.slice(0, opts.limit) : matched;
}
