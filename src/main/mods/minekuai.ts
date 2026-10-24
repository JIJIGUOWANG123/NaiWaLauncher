// 麦块社区（api.minekuai.cn）作为中文搜索源：服务端索引自带 title_zh / description_zh，
// 中文关键词直接可查，不需要先译成英文。
// 关键事实：条目的 project_id 就是 Modrinth 的 project_id（如 AANobbMI），所以文件列表、下载与依赖
// 全部沿用 modrinth 提供方 —— index.ts 的 nativeProvider 负责这次转换，本文件只管搜索与地图列表。
import type { LoaderKind, MapEntry, ModCategory, ModContentKind, ModSearchResult } from "../../shared/types";
import { getInstance } from "../minecraft/instances";
import {
  apiJson, canonicalLoader, clampLimit, httpStatusOf, jsonArray, jsonIdString, jsonNumber, jsonObject, jsonString,
  jsonStringArray, loaderAppliesTo, loaderTags, messageOf, SEARCH_LIMIT_DEFAULT, type ModProvider,
} from "./provider";
import { mt } from "../core/i18n";

/**
 * 内容类型 → 面板接口路径。地图不走面板接口（见下面的 MAP_LIST），单独处理。
 * 插件（mc-plugins）同样是公开面板接口，条目的 project_id 也是 Modrinth 项目 ID（实测 simple-voice-chat / 9eGKb6K1），
 * 所以插件不需要登录也能搜，文件列表与下载沿用 Modrinth 通道（见 servers/plugins.ts）。
 */
const PANEL_PATHS: Record<Exclude<ModContentKind, "map">, string> = {
  mod: "mc-mods",
  shader: "mc-shaders",
  resourcepack: "mc-resourcepacks",
  modpack: "mc-modpacks",
  plugin: "mc-plugins",
};

const PANEL_BASE = "https://api.minekuai.cn/panel/public/";

/** 社区地图列表：公开可读，但 mapFileUrl 全为 null（详情/下载要登录 token，401）。 */
const MAP_LIST = "https://api.minekuai.cn/client/resource/map/list";
const MAP_PAGE_SIZE = 20;

/** 官方论坛来源：面板接口对第三方 Origin 更宽容，缺 Referer 时偶尔回 403。 */
const HEADERS: Record<string, string> = {
  Origin: "https://bbs.minekuai.com",
  Referer: "https://bbs.minekuai.com/",
};

/** 服务端 limit 上限就是 50（传更大不会报错，但也不会多给）。 */
const SEARCH_LIMIT_MAX = 50;

/** 搜索结果缓存：同一个查询在页面反复触发时不再打网络（TTL 5 分钟）。 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;
const cache = new Map<string, { at: number; items: ModSearchResult[] }>();

/** 诊断用：自检脚本要统计真实请求次数时清空。 */
export function clearMinekuaiCache(): void {
  cache.clear();
}

function toSearchResult(raw: unknown): ModSearchResult {
  const hit = jsonObject(raw);
  const iconUrl = jsonString(hit.icon_url);
  const slug = jsonString(hit.slug);
  const titleZh = jsonString(hit.title_zh).trim();
  const summaryZh = jsonString(hit.description_zh).trim();
  return {
    provider: "minekuai",
    projectId: jsonString(hit.project_id) || slug,
    slug,
    title: jsonString(hit.title) || slug,
    // 契约固定用英文简介做 description；中文放到 summaryZh
    description: jsonString(hit.description_en).trim(),
    // 面板接口不提供作者字段
    author: "",
    downloads: jsonNumber(hit.downloads),
    iconUrl: iconUrl || undefined,
    categories: jsonStringArray(hit.categories),
    titleZh: titleZh || undefined,
    summaryZh: summaryZh || undefined,
  };
}

/**
 * 服务端没有 gameVersion / loader / category 参数，只能拿到条目自带的适用范围后本地过滤。
 * 分类与分辨率都落在 categories 字段里（分辨率就是 16x / 32x 这类同名分类），多个条件取 AND。
 */
function matchesFilters(raw: unknown, gameVersion?: string, loader?: LoaderKind, categories: string[] = []): boolean {
  const hit = jsonObject(raw);
  const version = gameVersion?.trim();
  if (version && !jsonStringArray(hit.game_versions).some((v) => v.trim() === version)) return false;
  const tags = loaderTags(loader);
  // 未指定加载器（或原版实例）时不做加载器约束：服务端条目普遍带 fabric/forge，过滤成空反而是错的
  if (tags.length > 0 && !jsonStringArray(hit.loaders).map(canonicalLoader).some((l) => tags.includes(l))) return false;
  if (categories.length === 0) return true;
  const own = jsonStringArray(hit.categories).map((c) => c.trim().toLowerCase());
  return categories.every((wanted) => own.includes(wanted));
}

function unavailable(err: unknown): Error {
  const status = httpStatusOf(err);
  return new Error(
    status !== null ? mt("mods.minekuaiApiUnavailable", { detail: mt("mods.minekuaiApiStatus", { status }) }) : mt("mods.minekuaiApiUnavailable", { detail: mt("mods.minekuaiApiError", { error: messageOf(err) }) }),
  );
}

export interface MinekuaiSearchOptions {
  kind: ModContentKind;
  query: string;
  gameVersion?: string;
  loader?: LoaderKind;
  limit?: number;
  offset?: number;
  /** 分类 id（条目的 categories 字段里有才算命中）。 */
  category?: string;
  /** 分辨率（16x / 32x …）：同样是 categories 里的一个值。 */
  resolution?: string;
}

/** 地图没有面板接口：先把 kind 收窄成面板能表达的四种。 */
function panelPath(kind: ModContentKind): string | undefined {
  return kind === "map" ? undefined : PANEL_PATHS[kind];
}

/** 服务端分类/分辨率只能本地筛，这里把两个条件合成一个待匹配集合。 */
function categoryFilters(opts: MinekuaiSearchOptions): string[] {
  return [opts.category, opts.resolution]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .filter((value) => value.length > 0);
}

/**
 * 按内容类型搜索麦块社区。q 为空时服务端按热门返回。
 * 返回的是 Modrinth 的项目 ID，安装/文件列表请交由 modrinth 提供方处理。
 */
export async function searchMinekuaiItems(opts: MinekuaiSearchOptions): Promise<ModSearchResult[]> {
  const { kind } = opts;
  const path = panelPath(kind);
  if (!path) throw new Error(mt("mods.minekuaiMapHint"));
  const q = opts.query ?? "";
  const take = clampLimit(opts.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const skip = Math.max(0, Math.trunc(opts.offset ?? 0));
  const effectiveLoader = loaderAppliesTo(kind) ? opts.loader : undefined;
  const wanted = categoryFilters(opts);
  const key = [kind, q, opts.gameVersion ?? "", effectiveLoader ?? "", take, skip, wanted.join(",")].join("|");

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items.map((item) => ({ ...item }));

  const params = new URLSearchParams({ q, limit: String(take), offset: String(skip) });
  const url = `${PANEL_BASE}${path}?${params.toString()}`;
  let body: unknown;
  try {
    body = await apiJson<unknown>(url, { headers: HEADERS });
  } catch (err) {
    throw unavailable(err);
  }

  // 本地过滤会减少条数：这是服务端没有筛选参数时的必然代价，宁可少给也不给用不了的版本
  const items = jsonArray(jsonObject(body).items)
    .filter((raw) => matchesFilters(raw, opts.gameVersion, effectiveLoader, wanted))
    .map(toSearchResult);

  // 浅拷贝进缓存：index.ts 的翻译会就地写 titleZh，别让缓存项被上层改写
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), items: items.map((item) => ({ ...item })) });
  return items;
}

/** 按内容类型搜索（历史入口，位置参数版）。 */
export async function searchMinekuaiByKind(
  kind: ModContentKind,
  q: string,
  gameVersion?: string,
  loader?: LoaderKind,
  limit?: number,
  offset?: number,
): Promise<ModSearchResult[]> {
  return searchMinekuaiItems({ kind, query: q, gameVersion, loader, limit, offset });
}

/** 模组搜索（历史入口，等价于 searchMinekuaiByKind("mod", ...)）。 */
export async function searchMinekuai(
  q: string,
  gameVersion?: string,
  loader?: LoaderKind,
  limit?: number,
  offset?: number,
): Promise<ModSearchResult[]> {
  return searchMinekuaiByKind("mod", q, gameVersion, loader, limit, offset);
}

// ---------- 分类与筛选项（facets） ----------

interface FacetEntry {
  value: string;
  count: number;
}

/** 全量 facets 带着 900+ 个版本 tag，按 kind 缓存半小时；失败不缓存。 */
const FACET_TTL_MS = 30 * 60_000;
const facetCache = new Map<ModContentKind, { at: number; data: Record<string, FacetEntry[]> }>();

/** 诊断用：自检脚本要统计真实请求次数时清空。 */
export function clearFacetCache(): void {
  facetCache.clear();
}

async function loadFacets(kind: ModContentKind): Promise<Record<string, FacetEntry[]>> {
  const hit = facetCache.get(kind);
  if (hit && Date.now() - hit.at < FACET_TTL_MS) return hit.data;
  const path = panelPath(kind);
  if (!path) return {};

  let body: unknown;
  try {
    body = await apiJson<unknown>(`${PANEL_BASE}${path}/facets`, { headers: HEADERS });
  } catch (err) {
    throw unavailable(err);
  }

  const data: Record<string, FacetEntry[]> = {};
  for (const [key, value] of Object.entries(jsonObject(body))) {
    data[key] = jsonArray(value)
      .map((raw) => {
        const entry = jsonObject(raw);
        return { value: jsonString(entry.value).trim(), count: jsonNumber(entry.count) };
      })
      .filter((entry) => entry.value.length > 0);
  }
  facetCache.set(kind, { at: Date.now(), data });
  return data;
}

/**
 * 麦块的分类列表：facets 的 categories 只有 value（16x / 32x 这类分辨率也在里面），
 * 因此 id 与展示名都用它，count 顺带带给界面排序用。
 */
export async function listMinekuaiCategories(kind: ModContentKind): Promise<ModCategory[]> {
  const facets = await loadFacets(kind);
  // 麦块的 categories facets 里混着加载器取值（fabric/forge/minecraft/datapack…）：
  // 加载器由 filterOptions 单独给，这里按 loaders facets 剔掉，免得分类下拉里冒出加载器
  const loaders = new Set((facets.loaders ?? []).map((entry) => entry.value));
  return (facets.categories ?? [])
    .filter((entry) => !loaders.has(entry.value))
    .map((entry) => ({
      id: entry.value,
      name: entry.value,
      count: entry.count > 0 ? entry.count : undefined,
    }));
}

/** facets 里出现过的游戏版本 tag；拿不到时返回空数组，调用方回退到 Mojang 清单。 */
export async function minekuaiVersionTags(kind: ModContentKind): Promise<string[]> {
  const facets = await loadFacets(kind);
  return (facets.game_versions ?? []).map((entry) => entry.value);
}

// ---------- 社区地图 ----------

/** supportedVersions 是逗号分隔的字符串，且可能带 v 前缀（"v26.2"）。 */
function splitVersions(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim().replace(/^[vV](?=\d)/, ""))
    .filter((item) => item.length > 0);
}

/** fileSize 既可能是数字也可能是数字字符串，取不到按 0。 */
function sizeOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * 版本兼容：空列表表示没写适用版本（无法判断）；相等算兼容，
 * 地图写 1.21 而实例是 1.21.4 也算（前缀匹配）。
 */
function compatibleWith(versions: string[], mcVersion?: string): boolean | undefined {
  const target = mcVersion?.trim();
  if (versions.length === 0 || !target) return undefined;
  return versions.some((version) => version === target || target.startsWith(`${version}.`));
}

function toMapEntry(raw: unknown, mcVersion?: string): MapEntry {
  const hit = jsonObject(raw);
  const versions = splitVersions(jsonString(hit.supportedVersions));
  const coverUrl = jsonString(hit.coverImagesUrl).trim();
  const downloadUrl = jsonString(hit.mapFileUrl).trim();
  const id = jsonIdString(hit.id);
  return {
    id,
    title: jsonString(hit.title).trim() || id,
    description: jsonString(hit.description).trim(),
    versions,
    fileSize: sizeOf(hit.fileSize),
    category: jsonString(hit.categoryName).trim(),
    author: jsonString(hit.userName).trim(),
    coverUrl: coverUrl || undefined,
    // 实测全为 null：下载要登录 token，界面应引导用户去网页
    downloadUrl: downloadUrl || undefined,
    compatible: compatibleWith(versions, mcVersion),
  };
}

/** 实例版本只用于标兼容性：实例不存在/读不出时不影响浏览。 */
async function instanceMcVersion(instanceId: string): Promise<string | undefined> {
  try {
    const instance = await getInstance(instanceId);
    return instance?.mcVersion?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 麦块社区地图列表（page 从 1 开始，每页固定 20 条）。 */
export async function listMapEntries(query: string, page: number, instanceId?: string): Promise<MapEntry[]> {
  const pageNum = Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
  const params = new URLSearchParams({
    pageNum: String(pageNum),
    pageSize: String(MAP_PAGE_SIZE),
    search: query ?? "",
  });

  let body: unknown;
  try {
    body = await apiJson<unknown>(`${MAP_LIST}?${params.toString()}`, { headers: HEADERS });
  } catch (err) {
    throw unavailable(err);
  }

  const mcVersion = instanceId ? await instanceMcVersion(instanceId) : undefined;
  return jsonArray(jsonObject(body).rows).map((raw) => toMapEntry(raw, mcVersion));
}

function normalize(kind: "search", raw: unknown): ModSearchResult;
function normalize(kind: "file", raw: unknown): never;
function normalize(kind: "search" | "file", raw: unknown): ModSearchResult | never {
  if (kind === "search") return toSearchResult(raw);
  throw new Error(mt("mods.minekuaiSearchOnly"));
}

export const minekuaiProvider: ModProvider = {
  id: "minekuai",
  label: mt("mods.provider.minekuai"),
  search: (req) =>
    searchMinekuaiItems({
      kind: req.kind ?? "mod",
      query: req.query ?? "",
      gameVersion: req.gameVersion,
      loader: req.loader,
      limit: req.limit,
      offset: req.offset,
      category: req.category,
      resolution: req.resolution,
    }),
  // 下面三个方法由 index.ts 的 nativeProvider 转给 modrinth，不会被调用；保留是为了满足接口。
  listFiles: () => Promise.reject(new Error(mt("mods.minekuaiFilesFromModrinth"))),
  getFile: () => Promise.reject(new Error(mt("mods.minekuaiDownloadFromModrinth"))),
  normalize,
};
