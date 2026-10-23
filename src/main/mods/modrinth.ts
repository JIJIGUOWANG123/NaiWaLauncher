import type { ModCategory, ModContentKind, ModFileInfo, ModSearchResult } from "../../shared/types";
import type { ModFilesRequest, ModSearchRequest } from "../../shared/ipc";
import {
  apiJson, cachedProject, clampLimit, httpStatusOf, jsonArray, jsonNumber, jsonObject, jsonString, jsonStringArray,
  loaderAppliesTo, loaderTags, canonicalLoader, toReleaseType, type ModBacklook, type ModBacklookFile,
  type ModProjectInfo, type ModProvider, type RawDependency, type ResolvedFile, type Sha1Lookup,
  SEARCH_LIMIT_DEFAULT, FILE_LIMIT_DEFAULT, FILE_LIMIT_MAX,
} from "./provider";
import { mt } from "../core/i18n";

// Modrinth 要求的 User-Agent 由 core/http 统一发送（NaiWaLauncher/0.1 (naiwa)）。
const BASE = "https://api.modrinth.com/v2";

const SEARCH_INDEX: Record<NonNullable<ModSearchRequest["sort"]>, string> = {
  relevance: "relevance",
  downloads: "downloads",
  updated: "updated",
};

/** 内容类型 → Modrinth 的 project_type（地图不走 Modrinth，按模组处理）。 */
const PROJECT_TYPE: Record<ModContentKind, string> = {
  mod: "mod",
  modpack: "modpack",
  resourcepack: "resourcepack",
  shader: "shader",
  map: "mod",
};

function toSearchResult(raw: unknown): ModSearchResult {
  const hit = jsonObject(raw);
  const iconUrl = jsonString(hit.icon_url);
  // 搜索命中的时间是 date_modified（"最近更新"排序用的也是它）；麦块条目没有时间字段，那边省略
  const updatedAt = jsonString(hit.date_modified) || jsonString(hit.updated);
  return {
    provider: "modrinth",
    projectId: jsonString(hit.project_id) || jsonString(hit.slug),
    slug: jsonString(hit.slug),
    title: jsonString(hit.title),
    description: jsonString(hit.description),
    author: jsonString(hit.author),
    downloads: jsonNumber(hit.downloads),
    iconUrl: iconUrl || undefined,
    categories: jsonStringArray(hit.categories),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function primaryFileOf(raw: unknown): Record<string, unknown> {
  const files = jsonArray(jsonObject(raw).files).map(jsonObject);
  return files.find((f) => f.primary === true) ?? files[0] ?? {};
}

function toFileInfo(raw: unknown): ModFileInfo {
  const version = jsonObject(raw);
  const file = primaryFileOf(raw);
  return {
    provider: "modrinth",
    fileId: jsonString(version.id),
    name: jsonString(version.name) || jsonString(version.version_number),
    fileName: jsonString(file.filename),
    downloadUrl: jsonString(file.url),
    gameVersions: jsonStringArray(version.game_versions),
    loaders: jsonStringArray(version.loaders).map(canonicalLoader),
    // 这里不知道目标实例，先置 false，由 provider.rankFiles 按实例如实置位。
    exactMatch: false,
    releaseType: toReleaseType(version.version_type),
    downloads: jsonNumber(version.downloads),
    publishedAt: jsonString(version.date_published),
  };
}

function sha1Of(raw: unknown): string | undefined {
  const sha1 = jsonString(jsonObject(primaryFileOf(raw).hashes).sha1);
  return sha1 || undefined;
}

async function search(req: ModSearchRequest): Promise<ModSearchResult[]> {
  const kind = req.kind ?? "mod";
  const facets: string[][] = [[`project_type:${PROJECT_TYPE[kind]}`]];
  if (req.gameVersion) facets.push([`versions:${req.gameVersion}`]);
  // 光影/资源包不吃加载器：带 fabric 之类的 facet 只会把结果筛空
  const tags = loaderAppliesTo(kind) ? loaderTags(req.loader) : [];
  if (tags.length > 0) facets.push(tags.map((t) => `categories:${t}`));
  // 分类与分辨率在 Modrinth 都是 categories facet（分辨率就是同名 category），各自一个 facet 即 AND
  const category = req.category?.trim();
  if (category) facets.push([`categories:${category}`]);
  const resolution = req.resolution?.trim();
  if (resolution) facets.push([`categories:${resolution}`]);

  const params = new URLSearchParams({
    query: req.query ?? "",
    limit: String(clampLimit(req.limit, SEARCH_LIMIT_DEFAULT, 100)),
    offset: String(Math.max(0, Math.trunc(req.offset ?? 0))),
    index: SEARCH_INDEX[req.sort ?? "relevance"],
    facets: JSON.stringify(facets),
  });
  const body = await apiJson<Record<string, unknown>>(`${BASE}/search?${params.toString()}`);
  return jsonArray(body.hits).map(toSearchResult);
}

/**
 * 某内容类型的分类标签（GET /tag/category 按 project_type 过滤）。
 * Modrinth 的 name 既是 id 也是展示名（本地化在前端做），icon 给 UI 映射用。
 */
export async function listModrinthCategories(kind: ModContentKind): Promise<ModCategory[]> {
  const projectType = PROJECT_TYPE[kind];
  const body = await apiJson<unknown>(`${BASE}/tag/category`);
  const seen = new Set<string>();
  const out: ModCategory[] = [];
  for (const entry of jsonArray(body).map(jsonObject)) {
    if (jsonString(entry.project_type) !== projectType) continue;
    const name = jsonString(entry.name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const icon = jsonString(entry.icon).trim();
    out.push({ id: name, name, icon: icon || undefined });
  }
  return out;
}

async function listFiles(req: ModFilesRequest): Promise<ModFileInfo[]> {
  const params = new URLSearchParams();
  if (req.gameVersion) params.set("game_versions", JSON.stringify([req.gameVersion]));
  const tags = loaderTags(req.loader);
  if (tags.length > 0) params.set("loaders", JSON.stringify(tags));
  const qs = params.toString();

  const url = `${BASE}/project/${encodeURIComponent(req.projectId)}/version${qs ? `?${qs}` : ""}`;
  const body = await apiJson<unknown>(url);
  const limit = clampLimit(req.limit, FILE_LIMIT_DEFAULT, FILE_LIMIT_MAX);
  return jsonArray(body)
    .map(toFileInfo)
    .filter((f) => f.downloadUrl !== "")
    .slice(0, limit);
}

/** 项目标题与 slug：文件名模板要用；失败返回 undefined，不影响安装。 */
async function getProject(projectId: string): Promise<ModProjectInfo | undefined> {
  return cachedProject("modrinth", projectId, async () => {
    const body = await apiJson<unknown>(`${BASE}/project/${encodeURIComponent(projectId)}`);
    const project = jsonObject(body);
    const title = jsonString(project.title);
    if (!title) return undefined;
    return { title, slug: jsonString(project.slug) || projectId };
  });
}

/** 项目类型 → 内容类型：Modrinth 的 project_type 与启动器的 kind 同名，直接映射即可。 */
const PROJECT_TYPE_KIND: Record<string, ModContentKind> = {
  mod: "mod",
  modpack: "modpack",
  resourcepack: "resourcepack",
  shader: "shader",
};

/** 依赖行要按项目类型落目录：查不到类型（项目不存在/接口失败）就返回 undefined，由调用方按模组兜底。 */
async function getProjectType(projectId: string): Promise<ModContentKind | undefined> {
  const body = await apiJson<unknown>(`${BASE}/project/${encodeURIComponent(projectId)}`);
  return PROJECT_TYPE_KIND[jsonString(jsonObject(body).project_type)];
}

async function getFile(projectId: string, fileId: string): Promise<ResolvedFile> {
  const body = await apiJson<unknown>(`${BASE}/version/${encodeURIComponent(fileId)}`);
  const info = toFileInfo(body);
  if (!info.downloadUrl) throw new Error(mt("mods.modrinthNoUrl", { file: fileId }));
  const project = await getProject(projectId);
  const owner = jsonString(jsonObject(body).project_id);
  // 界面可能传 slug（搜索结果里也可能给 slug），两种写法都算同一个项目
  const sameProject = !projectId || !owner || owner === projectId || project?.slug === projectId;
  if (!sameProject) {
    throw new Error(mt("mods.modrinthWrongProject", { file: fileId, project: projectId }));
  }
  // 安装索引要按规范 project_id 判重：调用方传 slug 时也不能写成 slug
  return { info, projectId: owner || undefined, sha1: sha1Of(body), project };
}

/** dependency_type 只有 required 才算必需前置；其余（optional/incompatible/embedded）都不装。 */
function requiredDependencies(body: unknown): RawDependency[] {
  const seen = new Set<string>();
  const out: RawDependency[] = [];
  for (const entry of jsonArray(jsonObject(body).dependencies).map(jsonObject)) {
    if (jsonString(entry.dependency_type) !== "required") continue;
    const projectId = jsonString(entry.project_id);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    const versionId = jsonString(entry.version_id);
    out.push({ projectId, versionId: versionId || undefined });
  }
  return out;
}

/**
 * 某个版本声明的必需前置。Dependencies 挂在版本（fileId）上，所以调用方必须先确定要装哪个文件；
 * 归属校验交给调用方（getFile 已经校验过一次），这里不额外发项目请求。
 */
async function getDependencies(_projectId: string, fileId: string): Promise<RawDependency[]> {
  const body = await apiJson<unknown>(`${BASE}/version/${encodeURIComponent(fileId)}`);
  return requiredDependencies(body);
}

/** 用文件 sha1 反查版本；404 表示 Modrinth 没收录这个文件，属于正常情况。 */
const backlook: ModBacklook = {
  provider: "modrinth",
  async lookup(file: ModBacklookFile): Promise<Sha1Lookup | undefined> {
    try {
      const body = await apiJson<unknown>(
        `${BASE}/version_file/${encodeURIComponent(file.sha1)}?algorithm=sha1`,
      );
      const projectId = jsonString(jsonObject(body).project_id);
      if (!projectId) return undefined;
      return { projectId, file: toFileInfo(body) };
    } catch (err) {
      if (httpStatusOf(err) === 404) return undefined;
      throw err;
    }
  },
};

export const modrinthBacklook = backlook;

export function normalize(kind: "search", raw: unknown): ModSearchResult;
export function normalize(kind: "file", raw: unknown): ModFileInfo;
export function normalize(kind: "search" | "file", raw: unknown): ModSearchResult | ModFileInfo {
  return kind === "search" ? toSearchResult(raw) : toFileInfo(raw);
}

export const modrinthProvider: ModProvider = {
  id: "modrinth",
  label: "Modrinth",
  search,
  listFiles,
  getFile,
  getDependencies,
  getProject,
  getProjectType,
  normalize,
};

/** 自检脚本用：直接验证 required 过滤与去重。 */
export { requiredDependencies as modrinthRequiredDependencies };
