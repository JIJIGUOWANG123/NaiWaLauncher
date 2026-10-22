// 模组详情：Modrinth 走官方 /v2/project；CurseForge 有 Key 走 /v1/mods（外加独立的描述接口），
// 无 Key 用 cfwidget 的只读项目数据拼装。两个来源都拿不到的字段一律留空，绝不用推测值填充，
// 中文只在 settings.translateMods 时由 translate.ts 实时补（摘要），正文太长不翻。
import type { ModDetail, ModProviderId } from "../../shared/types";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { fetchCfWidgetProject } from "./cfwidget";
import { splitGameVersions } from "./curseforge";
import {
  apiJson, canonicalLoader, httpStatusOf, jsonArray, jsonNumber, jsonObject, jsonString, jsonStringArray, messageOf,
} from "./provider";
import { translateText } from "./translate";

const log = logger("mods");

const MODRINTH_BASE = "https://api.modrinth.com/v2";
const CURSEFORGE_BASE = "https://api.curseforge.com/v1";

/** 摘要翻译前先截断：详情页的 summary 偶尔是整段自述。 */
const SUMMARY_CHARS = 200;

/** 详情页在列表和详情之间来回点时最容易重复请求，短缓存省网络；上限避免无界增长。 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 32;
const cache = new Map<string, { at: number; value: ModDetail }>();

export function clearDetailCache(): void {
  cache.clear();
}

function remember(key: string, value: ModDetail): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value });
}

/**
 * 模组详情。provider 只支持 modrinth / curseforge：
 * - modrinth：/v2/project/{id} + /members（作者）
 * - curseforge：有 Key 用官方 /v1/mods/{id} 与其 description；无 Key 用 cfwidget
 */
export async function getModDetail(provider: ModProviderId, projectId: string): Promise<ModDetail> {
  const id = String(projectId ?? "").trim();
  if (!id) throw new Error("缺少模组项目 id");
  const key = `${provider}:${id.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: ModDetail;
  switch (provider) {
    case "modrinth":
      value = await modrinthDetail(id);
      break;
    // 麦块社区的条目 project_id 就是 Modrinth 项目 ID：详情沿用 Modrinth，界面才不会点进空白页
    case "minekuai":
      value = await modrinthDetail(id);
      value.provider = "minekuai";
      break;
    case "curseforge":
      value = await curseforgeDetail(id);
      break;
    default:
      throw new Error(`未知的模组来源：${String(provider)}`);
  }
  value = await withChineseSummary(value);
  remember(key, value);
  return value;
}

/**
 * 摘要译文写 summaryZh（body 全文太长不翻），只有真的拿到译文才把 translated 置真。
 * 翻译失败或被限流只留空，详情照常返回。
 */
async function withChineseSummary(detail: ModDetail): Promise<ModDetail> {
  if (!getSettings().translateMods) return detail;
  const summary = detail.summary.slice(0, SUMMARY_CHARS).trim();
  if (!summary) return detail;
  try {
    const zh = (await translateText(summary, "zh-CN"))?.trim();
    if (!zh || zh === summary) return detail;
    return { ...detail, summaryZh: zh, translated: true };
  } catch (err) {
    log.warn(`详情摘要翻译失败（留空）：${detail.projectId} · ${messageOf(err)}`);
    return detail;
  }
}

// ---------- Modrinth ----------

/** 404 之外保持原样抛：上层要能从文案判断是「没这个模组」还是网络故障。 */
async function modrinthProject(projectId: string): Promise<Record<string, unknown>> {
  try {
    return jsonObject(await apiJson<unknown>(`${MODRINTH_BASE}/project/${encodeURIComponent(projectId)}`));
  } catch (err) {
    if (httpStatusOf(err) === 404) throw new Error(`Modrinth 没有找到模组「${projectId}」`);
    throw err;
  }
}

/** 项目接口不带作者，成员接口才有；查失败只让作者留空，不让详情整体失败。 */
async function modrinthAuthor(projectId: string): Promise<string> {
  try {
    const members = jsonArray(
      await apiJson<unknown>(`${MODRINTH_BASE}/project/${encodeURIComponent(projectId)}/members`),
    ).map(jsonObject);
    const owner = members.find((m) => /owner/i.test(jsonString(m.role))) ?? members[0];
    return jsonString(jsonObject(owner?.user).username);
  } catch (err) {
    log.warn(`读取 Modrinth 项目成员失败（作者留空）：${projectId} · ${messageOf(err)}`);
    return "";
  }
}

function modrinthLicense(project: Record<string, unknown>): string | undefined {
  const license = jsonObject(project.license);
  // Polyform 这类自定义许可 name 为空，只能退回 id 才有信息量
  return jsonString(license.name) || jsonString(license.id) || undefined;
}

async function modrinthDetail(projectId: string): Promise<ModDetail> {
  const project = await modrinthProject(projectId);
  const title = jsonString(project.title);
  if (!title) throw new Error(`Modrinth 项目 ${projectId} 返回的内容缺少标题`);
  const author = await modrinthAuthor(projectId);
  return {
    provider: "modrinth",
    projectId: jsonString(project.id) || projectId,
    slug: jsonString(project.slug) || projectId,
    title,
    summary: jsonString(project.description),
    body: jsonString(project.body),
    author,
    downloads: jsonNumber(project.downloads),
    followers: jsonNumber(project.followers),
    categories: jsonStringArray(project.categories),
    license: modrinthLicense(project),
    sourceUrl: jsonString(project.source_url) || undefined,
    iconUrl: jsonString(project.icon_url) || undefined,
    // gallery 里 raw_url 是全尺寸图，url 是缩略图
    gallery: jsonArray(project.gallery)
      .map(jsonObject)
      .map((item) => jsonString(item.raw_url) || jsonString(item.url))
      .filter((url) => url !== ""),
    updatedAt: jsonString(project.updated) || undefined,
    gameVersions: jsonStringArray(project.game_versions),
    loaders: jsonStringArray(project.loaders).map(canonicalLoader),
    translated: false,
  };
}

// ---------- CurseForge ----------

function curseforgeKey(): string {
  const key = getSettings().curseforgeApiKey;
  return typeof key === "string" ? key.trim() : "";
}

/** CurseForge 的 modLoaderType：1=Forge，4=Fabric，5=Quilt，6=NeoForge。 */
function cfLoaderTag(value: unknown): string {
  switch (jsonNumber(value)) {
    case 1:
      return "forge";
    case 4:
      return "fabric";
    case 5:
      return "quilt";
    case 6:
      return "neoforge";
    default:
      return "";
  }
}

/**
 * CurseForge 描述接口返回整段 HTML，界面按 Markdown 渲染，所以这里压成纯文本：
 * 块级标签转换行、列表项补 "- "、实体解码，其余标签直接去掉。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|br|h[1-6]|tr|ul|ol|table|pre|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 无 Key：cfwidget 只有项目元数据，没有画廊/更新时间/关注数，这些字段留空。 */
async function curseforgeDetailFromWidget(projectId: string): Promise<ModDetail> {
  const project = await fetchCfWidgetProject(projectId);
  const gameVersions = new Set<string>();
  const loaders = new Set<string>();
  for (const file of project.files) {
    const split = splitGameVersions(file.versions);
    for (const version of split.gameVersions) gameVersions.add(version);
    for (const loader of split.loaders) loaders.add(loader);
  }
  return {
    provider: "curseforge",
    projectId: project.id,
    slug: project.slug,
    title: project.title,
    summary: project.summary,
    body: htmlToText(project.description),
    author: project.author,
    downloads: project.downloads,
    categories: project.categories,
    sourceUrl: project.sourceUrl || undefined,
    iconUrl: project.iconUrl,
    gallery: [],
    gameVersions: [...gameVersions],
    loaders: [...loaders],
    translated: false,
  };
}

async function curseforgeDetail(projectId: string): Promise<ModDetail> {
  const key = curseforgeKey();
  // 没填 Key 只能用 cfwidget；官方接口无 Key 会 403
  if (!key) return curseforgeDetailFromWidget(projectId);

  const headers = { "x-api-key": key, Accept: "application/json" };
  const url = `${CURSEFORGE_BASE}/mods/${encodeURIComponent(projectId)}`;
  let mod: Record<string, unknown>;
  try {
    mod = jsonObject(jsonObject(await apiJson<unknown>(url, { headers })).data);
  } catch (err) {
    const status = httpStatusOf(err);
    if (status === 401 || status === 403) {
      throw new Error(`CurseForge 拒绝了该 API Key，请到设置里检查或重新填写（HTTP ${status}）`);
    }
    if (status === 404) throw new Error(`CurseForge 没有找到模组「${projectId}」`);
    throw err;
  }

  const title = jsonString(mod.name);
  if (!title) throw new Error(`CurseForge 项目 ${projectId} 返回的内容缺少名称`);
  // 描述是独立接口，失败不该让详情整体挂掉
  const description = await apiJson<unknown>(`${url}/description`, { headers }).catch((err: unknown) => {
    log.warn(`读取 CurseForge 描述失败（正文留空）：${projectId} · ${messageOf(err)}`);
    return "";
  });

  const gameVersions = new Set<string>();
  const loaders = new Set<string>();
  for (const entry of jsonArray(mod.latestFilesIndexes).map(jsonObject)) {
    const version = jsonString(entry.gameVersion);
    if (version) gameVersions.add(version);
    const loader = cfLoaderTag(entry.modLoader);
    if (loader) loaders.add(loader);
  }

  const links = jsonObject(mod.links);
  const logo = jsonObject(mod.logo);
  return {
    provider: "curseforge",
    projectId: String(jsonNumber(mod.id) || projectId),
    slug: jsonString(mod.slug) || projectId,
    title,
    summary: jsonString(mod.summary),
    body: htmlToText(typeof description === "string" ? description : ""),
    author: jsonString(jsonObject(jsonArray(mod.authors).map(jsonObject)[0]).name),
    downloads: jsonNumber(mod.downloadCount),
    categories: jsonArray(mod.categories).map(jsonObject).map((c) => jsonString(c.name)).filter((n) => n !== ""),
    sourceUrl: jsonString(links.sourceUrl) || undefined,
    iconUrl: jsonString(logo.thumbnailUrl) || jsonString(logo.url) || undefined,
    gallery: jsonArray(mod.screenshots)
      .map(jsonObject)
      .map((shot) => jsonString(shot.url) || jsonString(shot.thumbnailUrl))
      .filter((url) => url !== ""),
    updatedAt: jsonString(mod.dateModified) || undefined,
    gameVersions: [...gameVersions],
    loaders: [...loaders],
    translated: false,
  };
}
