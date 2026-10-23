import { unlink } from "node:fs/promises";
import type {
  InstalledModInfo, InstanceMeta, ModCategory, ModContentKind, ModDependency, ModFileInfo, ModFilterOptions,
  ModProviderId, ModSearchResult, VersionBrief,
} from "../../shared/types";
import type {
  ModFilesRequest, ModInstallRequest, ModInstallResult, ModSearchRequest, ModSourceFilter,
} from "../../shared/ipc";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { getInstance } from "../minecraft/instances";
import { listVersions } from "../minecraft/manifest";
import { curseforgeBacklook, curseforgeProvider, curseforgeSearchAvailable } from "./curseforge";
import {
  getModDependencies as resolveDependencies, installDependency, rememberInstalled,
} from "./dependencies";
import {
  downloadModFile, KIND_NOUN, listInstalledMods as listModsOnDisk, MAP_DOWNLOAD_HINT, removeContentFile, safeFileName,
} from "./install";
import { scanInstalledContent, type ScannedMod } from "./installed";
import { listMinekuaiCategories, minekuaiProvider, minekuaiVersionTags } from "./minekuai";
import { listModrinthCategories, modrinthBacklook, modrinthProvider } from "./modrinth";
import {
  bestFile, loaderAppliesTo, matchTier, mapLimit, messageOf, rankFiles, versionOnlyTier,
  type ModBacklook, type ModProvider, type ResolvedFile,
} from "./provider";
import { installModpackFrom, type ModpackInstallResult } from "./modpack";
import { containsCjk, translateBatch, translateText } from "./translate";

const log = logger("mods");

/** 模组详情（介绍/画廊/许可/链接）：IPC mods:detail 的入口。 */
export { clearDetailCache, getModDetail } from "./detail";
/** 内容类型搜索（光影/资源包/整合包）与社区地图列表：IPC mods:search / mods:maps 的入口。 */
export { listMapEntries, searchMinekuaiByKind } from "./minekuai";
/** 实例里已装内容的索引记录（磁盘核对过）：IPC mods:installedContent 的入口。 */
export { listInstalledContent } from "./dependencies";

const PROVIDERS: Record<ModProviderId, ModProvider> = {
  modrinth: modrinthProvider,
  curseforge: curseforgeProvider,
  minekuai: minekuaiProvider,
};

/** 反查顺序：Modrinth 按 sha1 直查，未收录再整批问 CurseForge 指纹。 */
const BACKLOOKS: ModBacklook[] = [modrinthBacklook, curseforgeBacklook];

/** 来源 API 有速率限制，反查并发别开太大。 */
const BACKLOOK_CONCURRENCY = 4;

function resolveProvider(id: ModProviderId): ModProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`未知的模组来源：${String(id)}`);
  return provider;
}

/**
 * 麦块社区只提供搜索：它的条目 project_id 就是 Modrinth 的 project_id，
 * 所以文件列表、下载、依赖与更新一律转交 modrinth 提供方（沿用已验证的路径）。
 */
const NATIVE_PROVIDER: Partial<Record<ModProviderId, ModProviderId>> = { minekuai: "modrinth" };

function nativeProviderOf(id: ModProviderId): ModProviderId {
  const native = NATIVE_PROVIDER[id];
  return native && PROVIDERS[native] ? native : id;
}

async function requireInstance(instanceId: string) {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error(`实例不存在：${instanceId}`);
  return instance;
}

// ---------- 中文搜索与实时翻译 ----------

/** 一次搜索最多翻的标题数（= 前 20 条；中文 query 那次翻译另算，共 21 次上限）。 */
const SEARCH_TRANSLATE_LIMIT = 20;

/**
 * 给前 20 条结果补中文标题：同样的标题只翻一次，撞上限流就提前收手，其余保留原文。
 * 简介不在这里翻（接口按 IP 限流，一次搜索塞 40 次调用只会整页 429）；详情页才翻 summary。
 */
async function translateResults(results: ModSearchResult[]): Promise<void> {
  const head = results.slice(0, SEARCH_TRANSLATE_LIMIT);
  if (head.length === 0) return;
  const queue: string[] = [];
  const targets = new Map<string, number[]>();
  head.forEach((mod, index) => {
    const title = mod.title.trim();
    if (!title) return;
    const known = targets.get(title);
    if (known) {
      known.push(index);
      return;
    }
    targets.set(title, [index]);
    queue.push(title);
  });
  if (queue.length === 0) return;

  const translated = await translateBatch(queue, "zh-CN");
  queue.forEach((title, position) => {
    const value = translated[position];
    // 译文与原文一致（来源本身就是中文）时不留冗余字段，界面直接用 title
    if (value === undefined || value.trim() === title) return;
    for (const index of targets.get(title) ?? []) {
      // 来源自带的中文名（麦块社区）优先，不用机翻覆盖
      if (!head[index].titleZh) head[index].titleZh = value;
    }
  });
}

/**
 * 来源站点的索引基本是英文：中文搜索词先译成英文再检索，翻译失败/限流就用原文。
 * 麦块社区的索引本身就是中文（自带 title_zh / description_zh），译成英文反而丢掉它的优势，所以不调这里。
 */
async function englishQuery(query: string): Promise<string> {
  if (!getSettings().translateSearch || !containsCjk(query)) return query;
  try {
    const translated = (await translateText(query, "en"))?.trim();
    if (translated) return translated;
    log.warn(`搜索词没有译文（限流或缓存为空），改用原文检索：${query}`);
  } catch (err) {
    log.warn(`搜索词翻译失败，改用原文检索：${query} · ${messageOf(err)}`);
  }
  return query;
}

export async function searchMods(req: ModSearchRequest): Promise<ModSearchResult[]> {
  const query = req.query ?? "";
  const source = req.source ?? "all";

  let results: ModSearchResult[];
  // 地图不走面板搜索接口：聚合对它是噪音，直接交给单来源路径报出可比对的错误
  if (source === "all" && (req.kind ?? "mod") !== "map") {
    // 麦块用中文原文，Modrinth/CurseForge 用英文译文：两边各用自己索引的语言
    results = await searchEverySource(req, query, await englishQuery(query));
  } else {
    const localized = source === "minekuai" ? query : await englishQuery(query);
    results = await resolveProvider(req.provider).search({ ...req, query: localized });
  }

  if (!getSettings().translateMods) return results;
  await translateResults(results);
  return results;
}

// ---------- 多来源合并（source = "all"） ----------

/** 合并后的上限：单来源各取 40 条，统一排序后仍只给 40 条。 */
const ALL_SOURCES_LIMIT = 40;
/** 每个来源在聚合模式下的取数（Modrinth 上限 100，麦块上限 50）。 */
const ALL_SOURCES_PER_SOURCE = 40;

const SOURCE_LABELS: Record<ModProviderId, string> = {
  modrinth: "Modrinth",
  curseforge: "CurseForge",
  minekuai: "麦块社区",
};

/**
 * 同一 projectId 的两条结果合并：麦块条目带中文名/简介，优先保留；
 * 下载量取两边的较大值（麦块的统计口径与 Modrinth 略有差异，取大不会低估热度）。
 */
function mergeSearchHits(a: ModSearchResult, b: ModSearchResult): ModSearchResult {
  const base = !a.titleZh && b.titleZh ? b : a;
  const other = base === a ? b : a;
  return {
    ...base,
    slug: base.slug || other.slug,
    author: base.author || other.author,
    iconUrl: base.iconUrl ?? other.iconUrl,
    titleZh: base.titleZh ?? other.titleZh,
    summaryZh: base.summaryZh ?? other.summaryZh,
    downloads: Math.max(a.downloads, b.downloads),
  };
}

/**
 * 「所有来源」：并发查询后按 projectId 合并去重，统一按下载量降序。
 * 单个来源失败只记 warn（一个站点抽风不该让整页空白），全部失败才抛错。
 */
async function searchEverySource(
  req: ModSearchRequest,
  queryZh: string,
  queryEn: string,
): Promise<ModSearchResult[]> {
  const kind = req.kind ?? "mod";
  const shared = { ...req, source: undefined, limit: ALL_SOURCES_PER_SOURCE, offset: 0 };
  const jobs: { label: string; run: () => Promise<ModSearchResult[]> }[] = [];

  if (kind !== "map") {
    jobs.push({
      label: SOURCE_LABELS.modrinth,
      run: () => modrinthProvider.search({ ...shared, provider: "modrinth", query: queryEn }),
    });
    // 无 Key 的 CurseForge 只能按 id/slug 精确解析，且它的搜索接口只覆盖模组与整合包
    if (kind === "mod" && curseforgeSearchAvailable()) {
      jobs.push({
        label: SOURCE_LABELS.curseforge,
        run: () => curseforgeProvider.search({ ...shared, provider: "curseforge", query: queryEn }),
      });
    }
  }
  jobs.push({
    label: SOURCE_LABELS.minekuai,
    run: () => minekuaiProvider.search({ ...shared, provider: "minekuai", query: queryZh }),
  });

  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const merged: ModSearchResult[] = [];
  const byProject = new Map<string, number>();
  let failure: unknown;
  let failed = 0;

  settled.forEach((outcome, index) => {
    const { label } = jobs[index];
    if (outcome.status === "rejected") {
      failed += 1;
      failure = outcome.reason;
      log.warn(`${label} 搜索失败，本次跳过该来源：${messageOf(outcome.reason)}`);
      return;
    }
    for (const item of outcome.value) {
      // projectId 是跨来源的同一把钥匙（麦块条目直接就是 Modrinth 的项目 id）
      const key = item.projectId || `${item.provider}:${item.slug || item.title}`;
      const at = byProject.get(key);
      if (at === undefined) {
        byProject.set(key, merged.length);
        merged.push(item);
        continue;
      }
      merged[at] = mergeSearchHits(merged[at], item);
    }
  });

  if (merged.length === 0 && failed === jobs.length) {
    throw new Error(`所有来源都搜索失败：${messageOf(failure)}`);
  }
  return merged.sort((a, b) => b.downloads - a.downloads).slice(0, ALL_SOURCES_LIMIT);
}

// ---------- 分类与筛选项 ----------

/** 光影/资源包不吃加载器，整合包与模组才有意义。 */
const LOADER_OPTIONS = ["fabric", "forge", "neoforge", "quilt", "liteloader"];
/** Modrinth 的资源包/光影分辨率就是同名 category，选项与之一致。 */
const RESOLUTION_OPTIONS = ["16x", "32x", "48x", "64x", "128x", "256x", "512x"];

/**
 * 分类列表：多来源时合并去重（同 id 保留麦块的 count 与 Modrinth 的图标）。
 * CurseForge 的分类 id 体系与 Modrinth 不通用、且要 Key，这里不参与。
 */
export async function listCategories(
  kind: ModContentKind,
  source: ModSourceFilter = "all",
): Promise<ModCategory[]> {
  const jobs: { label: string; run: () => Promise<ModCategory[]> }[] = [];
  if (source === "all" || source === "modrinth") {
    jobs.push({ label: SOURCE_LABELS.modrinth, run: () => listModrinthCategories(kind) });
  }
  if (source === "all" || source === "minekuai") {
    jobs.push({ label: SOURCE_LABELS.minekuai, run: () => listMinekuaiCategories(kind) });
  }
  if (jobs.length === 0) return [];

  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const merged: ModCategory[] = [];
  const byId = new Map<string, number>();
  let failure: unknown;
  let failed = 0;

  settled.forEach((outcome, index) => {
    const { label } = jobs[index];
    if (outcome.status === "rejected") {
      failed += 1;
      failure = outcome.reason;
      log.warn(`${label} 分类获取失败，本次跳过该来源：${messageOf(outcome.reason)}`);
      return;
    }
    for (const category of outcome.value) {
      const at = byId.get(category.id);
      if (at === undefined) {
        byId.set(category.id, merged.length);
        merged.push(category);
        continue;
      }
      merged[at] = {
        ...merged[at],
        count: merged[at].count ?? category.count,
        icon: merged[at].icon ?? category.icon,
      };
    }
  });

  if (merged.length === 0 && failed === jobs.length) {
    throw new Error(`分类列表获取失败：${messageOf(failure)}`);
  }
  return merged;
}

/** 清单里的正式版在前（新→旧），facets 里多出来的版本补在后面。 */
function mergeVersions(manifest: VersionBrief[], facets: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (entry.type !== "release" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  for (const version of facets) {
    if (seen.has(version)) continue;
    seen.add(version);
    out.push(version);
  }
  return out;
}

/** 某内容类型的筛选项：版本吃 Mojang 清单 + 麦块 facets，加载器与分辨率按内容类型给。 */
export async function listFilterOptions(kind: ModContentKind): Promise<ModFilterOptions> {
  const [manifest, facets] = await Promise.all([
    listVersions().catch((err) => {
      log.warn(`版本清单获取失败，版本筛选项只用来源 facets：${messageOf(err)}`);
      return [] as VersionBrief[];
    }),
    minekuaiVersionTags(kind).catch((err) => {
      log.warn(`麦块 facets 获取失败，版本筛选项只用清单：${messageOf(err)}`);
      return [] as string[];
    }),
  ]);

  return {
    versions: mergeVersions(manifest, facets),
    loaders: loaderAppliesTo(kind) ? [...LOADER_OPTIONS] : [],
    resolutions: kind === "resourcepack" || kind === "shader" ? [...RESOLUTION_OPTIONS] : [],
  };
}

export async function listModFiles(req: ModFilesRequest): Promise<ModFileInfo[]> {
  // 麦块社区的结果就是 Modrinth 项目：文件列表交给 modrinth 提供方（kind 只影响排序口径）
  const provider = nativeProviderOf(req.provider);
  const files = await resolveProvider(provider).listFiles({ ...req, provider });
  // 排序与 exactMatch 判定只做一次，两个来源共用同一套规则；光影/资源包不参与加载器判定
  const loader = loaderAppliesTo(req.kind ?? "mod") ? req.loader : undefined;
  return rankFiles(files, req.gameVersion, loader);
}

/** 查某个项目（或指定文件）的必需前置，并标注实例里是否已装；kind 是本体自己的内容类型。 */
export async function getModDependencies(
  provider: ModProviderId,
  projectId: string,
  instanceId: string,
  fileId?: string,
  kind: ModContentKind = "mod",
): Promise<ModDependency[]> {
  const instance = await requireInstance(instanceId);
  return resolveDependencies(resolveProvider(nativeProviderOf(provider)), projectId, instance, fileId, kind);
}

/**
 * 补齐缺失的必需前置（按来源给出的顺序）。
 * 任何一个前置失败就整体中止并说明已装上哪些：宁可让用户看到半成品清单，也不装出一个缺前置的实例。
 */
async function installMissingDependencies(
  instance: InstanceMeta,
  missing: ModDependency[],
  signal?: AbortSignal,
): Promise<string[]> {
  const installed: string[] = [];
  for (const dep of missing) {
    const label = dep.name || dep.slug || dep.projectId;
    // 每个前置按它自己声明的来源装：光影的内置前置（Iris/Oculus）来自 Modrinth，本体可能来自 CurseForge
    const provider = resolveProvider(nativeProviderOf(dep.provider));
    try {
      const result = await installDependency(provider, instance, dep, signal);
      installed.push(label);
      log.info(`已安装前置 ${label} → ${result.fileName}`);
    } catch (err) {
      const done = installed.length > 0 ? `已装上的前置：${installed.join("、")}；` : "";
      throw new Error(
        `前置 ${label} 安装失败：${messageOf(err)}（${done}本体未安装；重试会跳过已装前置）`,
      );
    }
  }
  return installed;
}

/** 地图详情/下载要登录麦块社区，只能把社区地址交给用户自己去找。 */
const MAP_WEB_URL = "https://bbs.minekuai.com/";

/** 复制社区网页地址（主进程 clipboard；普通 node 自检环境里静默跳过）。 */
async function copyMapWebUrl(): Promise<void> {
  try {
    const electron = (await import("electron")) as { clipboard?: { writeText(text: string): void } };
    electron.clipboard?.writeText(MAP_WEB_URL);
  } catch (err) {
    log.warn(`复制地图网页地址失败：${messageOf(err)}`);
  }
}

/** 会去解析前置的内容类型：整合包/地图装的是成品，它们的「依赖」在包里自带了。 */
const DEPENDENCY_KINDS: ModContentKind[] = ["mod", "shader", "resourcepack"];

export async function installMod(req: ModInstallRequest, signal?: AbortSignal): Promise<ModInstallResult> {
  const kind = req.kind ?? "mod";
  // 地图的 mapFileUrl 实测全为 null（下载接口要登录 token）：先说清楚去哪儿下，再抛给界面
  if (kind === "map") {
    await copyMapWebUrl();
    throw new Error(MAP_DOWNLOAD_HINT);
  }

  const instance = await requireInstance(req.instanceId);
  // minekuai 的项目 ID 就是 Modrinth ID：依赖、文件与下载全部走 modrinth
  const provider = resolveProvider(nativeProviderOf(req.provider));
  // 光影/资源包没有加载器概念，选文件时不做加载器约束（否则会挑到别的加载器分支）
  const rankLoader = loaderAppliesTo(kind) ? instance.loader : undefined;

  // 先定下要装哪个文件：依赖清单与本体必须针对同一个文件，也避免把五档匹配算两遍
  let targetFileId = req.fileId;
  if (!targetFileId) {
    const files = await provider.listFiles({
      provider: provider.id,
      projectId: req.projectId,
      gameVersion: instance.mcVersion,
      loader: rankLoader,
    });
    const best = bestFile(files, instance.mcVersion, rankLoader);
    if (!best) {
      throw new Error(`项目 ${req.projectId} 没有适用于 ${instance.mcVersion} / ${instance.loader} 的文件`);
    }
    targetFileId = best.fileId;
  }

  // 先把前置补齐再动本体：本体装到一半才发现缺前置是最难收拾的状态
  let installedDependencies: string[] = [];
  // 模组/光影/资源包都可能缺前置（光影要靠 Iris/Oculus 才加载得起来）；整合包是成品，装它不拉依赖
  if (DEPENDENCY_KINDS.includes(kind) && req.installDependencies) {
    // required 已由来源侧过滤过，这里再守一次；已装的直接跳过（幂等，不重复下载也不产生 .bak）
    const deps = await resolveDependencies(provider, req.projectId, instance, targetFileId, kind);
    installedDependencies = await installMissingDependencies(
      instance,
      deps.filter((dep) => dep.required && !dep.installed),
      signal,
    );
  }

  // 回查文件详情为了拿到下载校验用的 sha1，同时保证 fileId 与项目一致
  const resolved: ResolvedFile = await provider.getFile(req.projectId, targetFileId);

  // 文件名模板要的标题/slug 由项目接口补（带进程内缓存，同一项目只查一次，前置已查过时命中缓存）
  const project = await provider.getProject?.(req.projectId);
  const result = await downloadModFile(
    instance,
    resolved,
    project ? { name: project.title, slug: project.slug } : undefined,
    kind,
    signal,
  );
  await rememberInstalled(instance.id, result.fileName, {
    provider: provider.id,
    projectId: resolved.projectId ?? req.projectId,
    versionId: resolved.info.fileId,
    kind,
  });
  return { ...result, installedDependencies };
}

/**
 * 一键安装整合包：挑 .mrpack → 下到 NaiWa/downloads → 新建实例（版本与加载器取自索引）→ 装文件与 overrides。
 * 麦块社区的整合包条目同样是 Modrinth 项目，一律走 modrinth 的 .mrpack 流程。
 */
export async function installModpack(
  provider: ModProviderId,
  projectId: string,
  fileId?: string,
  instanceName?: string,
  signal?: AbortSignal,
): Promise<ModpackInstallResult> {
  return installModpackFrom(resolveProvider(nativeProviderOf(provider)), { projectId, fileId, instanceName }, signal);
}

// ---------- 实例级模组管理 ----------

interface BacklookHit {
  provider: ModProviderId;
  projectId: string;
  file: ModFileInfo;
}

interface UpdatePlan {
  provider: ModProviderId;
  projectId: string;
  /** 要装的目标文件。 */
  file: ModFileInfo;
}

interface UpdateProbe {
  status: "update" | "latest" | "unknown" | "no-match";
  /** 已识别的来源项目：即使没有更新，也让界面知道这个文件属于谁。 */
  source?: { provider: ModProviderId; projectId: string };
  plan?: UpdatePlan;
  detail?: string;
}

/** 剥掉内部字段 path，只把契约里的 InstalledModInfo 交给渲染进程。 */
function toPublic(mod: ScannedMod): InstalledModInfo {
  const { path: _path, ...info } = mod;
  return info;
}

/**
 * sha1 反查来源：先逐个问 Modrinth（未收录返回 404），剩下的整批交给 CurseForge 指纹接口。
 * 单个文件查询失败只记 warn，不拖垮整批。
 */
async function resolveSources(mods: ScannedMod[]): Promise<Map<string, BacklookHit>> {
  const hits = new Map<string, BacklookHit>();
  if (mods.length === 0) return hits;

  const [modrinth, curseforge] = BACKLOOKS;
  await mapLimit(mods, BACKLOOK_CONCURRENCY, async (mod) => {
    try {
      const hit = await modrinth.lookup({ path: mod.path, sha1: mod.sha1 });
      if (hit) hits.set(mod.fileName, { provider: modrinth.provider, projectId: hit.projectId, file: hit.file });
    } catch (err) {
      log.warn(`反查 Modrinth 失败：${mod.fileName} · ${messageOf(err)}`);
    }
  });

  const pending = mods.filter((mod) => !hits.has(mod.fileName));
  if (pending.length === 0) return hits;
  try {
    const batch = curseforge.lookupBatch
      ? await curseforge.lookupBatch(pending.map((mod) => ({ path: mod.path, sha1: mod.sha1 })))
      : new Map<string, { projectId: string; file: ModFileInfo }>();
    for (const mod of pending) {
      const hit = batch.get(mod.sha1);
      if (hit) hits.set(mod.fileName, { provider: curseforge.provider, projectId: hit.projectId, file: hit.file });
    }
  } catch (err) {
    log.warn(`反查 CurseForge 失败，${pending.length} 个文件本次跳过 · ${messageOf(err)}`);
  }
  return hits;
}

/**
 * 候选文件只接受 loader 匹配且同版本/同系列：档位 2 以后意味着换 MC 版本，宁可报错也不降级安装。
 * 光影/资源包没有加载器概念（它们的 files.loaders 是 minecraft/iris 之类），只按版本档位 ≤1 筛。
 */
function pickCandidate(files: ModFileInfo[], instance: InstanceMeta, kind: ModContentKind): ModFileInfo | undefined {
  if (loaderAppliesTo(kind)) {
    const usable = files.filter((file) => matchTier(file, instance.mcVersion, instance.loader) <= 1);
    return rankFiles(usable, instance.mcVersion, instance.loader)[0];
  }
  const usable = files
    .map((file) => ({ file, tier: versionOnlyTier(file, instance.mcVersion) }))
    .filter((entry) => entry.tier <= 1)
    .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : publishedMs(b.file) - publishedMs(a.file)));
  return usable[0]?.file;
}

function publishedMs(file: ModFileInfo): number {
  const time = Date.parse(file.publishedAt);
  return Number.isFinite(time) ? time : 0;
}

/** 对每个源命中项取「当前实例版本（+ 加载器）」下的最优文件，判断是否更新。 */
async function probeUpdates(
  instance: InstanceMeta,
  mods: ScannedMod[],
  kind: ModContentKind,
): Promise<Map<string, UpdateProbe>> {
  const probes = new Map<string, UpdateProbe>();
  if (mods.length === 0) return probes;
  const hits = await resolveSources(mods);

  await mapLimit(mods, BACKLOOK_CONCURRENCY, async (mod) => {
    const hit = hits.get(mod.fileName);
    if (!hit) {
      probes.set(mod.fileName, { status: "unknown" });
      return;
    }
    const source = { provider: hit.provider, projectId: hit.projectId };
    try {
      const provider = resolveProvider(nativeProviderOf(hit.provider));
      const byLoader = loaderAppliesTo(kind);
      const files = await provider.listFiles({
        provider: provider.id,
        projectId: hit.projectId,
        gameVersion: instance.mcVersion,
        loader: byLoader ? instance.loader : undefined,
      });
      const candidate = pickCandidate(files, instance, kind);
      if (!candidate) {
        probes.set(mod.fileName, {
          status: "no-match",
          source,
          detail: byLoader
            ? `项目 ${hit.projectId} 没有适用于 ${instance.mcVersion} / ${instance.loader} 的文件`
            : `项目 ${hit.projectId} 没有适用于 ${instance.mcVersion} 的文件`,
        });
        return;
      }
      // 同一 fileId 说明远端最优就是当前这件；发布时间不更晚也不更新（避免把回退档当成更新）
      if (candidate.fileId === hit.file.fileId || publishedMs(candidate) <= publishedMs(hit.file)) {
        probes.set(mod.fileName, { status: "latest", source });
        return;
      }
      probes.set(mod.fileName, {
        status: "update",
        source,
        plan: { provider: hit.provider, projectId: hit.projectId, file: candidate },
      });
    } catch (err) {
      log.warn(`检查更新失败：${mod.fileName} · ${messageOf(err)}`);
      probes.set(mod.fileName, { status: "unknown", source });
    }
  });
  return probes;
}

export async function installed(instanceId: string, kind: ModContentKind = "mod"): Promise<InstalledModInfo[]> {
  await requireInstance(instanceId);
  // 列表只要名字/大小/可更新标记：不算 sha1（读满整个目录字节是这里最贵的部分），走轻量扫描 + 缓存
  const mods = await scanInstalledContent(instanceId, kind, { hash: false });
  return mods.map(toPublic);
}

export async function checkUpdates(instanceId: string, kind: ModContentKind = "mod"): Promise<InstalledModInfo[]> {
  const instance = await requireInstance(instanceId);
  // 反查更新必须按内容哈希问远端：这里一定要算 sha1，不能走轻量扫描
  const mods = await scanInstalledContent(instanceId, kind, { hash: true });
  const probes = await probeUpdates(instance, mods, kind);

  return mods.map((mod) => {
    const info = toPublic(mod);
    const probe = probes.get(mod.fileName);
    if (probe?.source) {
      info.provider = probe.source.provider;
      info.projectId = probe.source.projectId;
    }
    if (probe?.status === "update" && probe.plan) {
      info.update = {
        provider: probe.plan.provider,
        projectId: probe.plan.projectId,
        fileId: probe.plan.file.fileId,
        fileName: probe.plan.file.fileName,
        versionLabel: probe.plan.file.name || probe.plan.file.fileName,
      };
    }
    return info;
  });
}

export async function remove(instanceId: string, fileName: string, kind: ModContentKind = "mod"): Promise<void> {
  await requireInstance(instanceId);
  // 后缀与目录都由 kind 决定：模组只认 .jar，光影/资源包只认 .zip
  await removeContentFile(instanceId, safeFileName(fileName), kind);
}

/**
 * 下载目标文件 → 校验 sha1 → 成功后才删旧 jar 与旧 .bak。
 * 任何一步失败都不动旧文件，实例里不会出现「装了半截」的状态。
 */
export async function update(
  instanceId: string,
  fileName: string,
  kind: ModContentKind = "mod",
): Promise<{ fileName: string; path: string }> {
  const instance = await requireInstance(instanceId);
  const target = safeFileName(fileName);
  const mods = await scanInstalledContent(instanceId, kind, { hash: true });
  const mod = mods.find((item) => item.fileName === target);
  if (!mod) throw new Error(`${KIND_NOUN[kind]}文件不存在：${target}`);

  const probes = await probeUpdates(instance, [mod], kind);
  const probe = probes.get(target);
  if (!probe || probe.status === "unknown") {
    throw new Error(`无法反查 ${target} 的来源（Modrinth / CurseForge 都未收录），请手动更新`);
  }
  if (probe.status === "no-match") throw new Error(probe.detail ?? `没有适用于 ${instance.mcVersion} / ${instance.loader} 的文件`);
  if (probe.status !== "update" || !probe.plan) throw new Error(`已是最新版本：${target}`);

  const plan = probe.plan;
  // 走提供方详情接口拿下载地址与 sha1，装完再清旧文件
  const resolved = await resolveProvider(nativeProviderOf(plan.provider)).getFile(plan.projectId, plan.file.fileId);
  const result = await downloadModFile(instance, resolved, undefined, kind);

  // 索引跟着换成新文件：否则依赖判重还指着已经删掉的旧文件
  await rememberInstalled(instance.id, result.fileName, {
    provider: plan.provider,
    projectId: resolved.projectId ?? plan.projectId,
    versionId: resolved.info.fileId,
    kind,
  });

  if (result.fileName !== target) await unlink(mod.path);
  await unlink(`${mod.path}.bak`).catch(() => undefined);
  log.info(`已更新：${target} → ${result.fileName}`);
  return result;
}

export async function listInstalledMods(instanceId: string): Promise<{ fileName: string; sizeBytes: number }[]> {
  await requireInstance(instanceId);
  return listModsOnDisk(instanceId);
}
