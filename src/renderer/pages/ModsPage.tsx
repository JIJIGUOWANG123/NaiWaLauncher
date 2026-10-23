import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DownloadJob, InstanceMeta, InstalledContentRef, LoaderKind, MapEntry, ModCategory, ModContentKind, ModDependency,
  ModFileInfo, ModFilterOptions, ModProviderId, ModSearchResult,
} from "../../shared/types";
import { api } from "../lib/api";
import { formatAgo, formatCount, formatDate, loaderLabel } from "../lib/format";
import {
  KIND_BADGE_KEY, KIND_DIR, KIND_EMPTY_HINT_KEY, KIND_FILE_ACTION_KEY, KIND_INSTALL_LABEL_KEY, KIND_PLACEHOLDER_KEY,
  KIND_TABS, MAPS_NOTICE_KEY, MAPS_WEB_URL, SORT_OPTIONS_KEY, isBackendKind, kindLabel, loaderOptionLabel, sourceBadge,
  showsLoader, showsResolution,
  type KindFilesRequest, type KindInstallRequest, type KindSearchRequest, type ModSort,
  type UiContentKind,
} from "../lib/modKind";
import { useT } from "../lib/i18n";
import { perfNow, perfSince } from "../lib/perf";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { AnchoredMenu } from "../components/AnchoredMenu";
import { ModDetailPanel } from "../components/ModDetailPanel";
import { ModDepsDialog, type DepsChoice } from "../components/ModDepsDialog";
import { MapCards } from "../components/MapCards";
import { ConfirmDialog, Modal } from "../components/Modal";
import { MatchTag, ReleaseTypeTag } from "../components/Badges";
import { Select } from "../components/Form";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { IconChevronDown, IconClose, IconDownload, IconRefresh, IconSearch } from "../components/icons";

/** 详情面板底部按钮没有具体文件 id，用它作为「正在安装」的占位标记。 */
const INSTALL_PANEL_KEY = "__panel__";

/** 整合包新建实例，没有目标实例：key 里用这个固定后缀占位。 */
const PACK_SCOPE = "__pack__";

/** 取消/失败/完成这些状态没有顺序意义，比较时只用来挑选「最该显示的那一条」。 */
const PHASE_RANK: Record<string, number> = { running: 4, queued: 3, failed: 2, cancelled: 1, done: 0 };

/**
 * 安装条目 key：一次安装 = 来源 × 项目 × 文件 × 目标实例。
 * 文件与实例都参与，所以同一项目分别装到两个实例、或同一项目装两个不同文件，互不遮挡。
 */
function installKeyOf(
  provider: ModProviderId, projectId: string, fileId: string | null | undefined, instanceId: string,
): string {
  return `${provider}:${projectId}:${fileId ?? ""}:${instanceId || PACK_SCOPE}`;
}

/**
 * 安装级并发上限＝设置里的「同时下载数」（与主进程闸门读同一个值）。
 * 在这里也按它排一次队，界面才知道哪几条还在「排队中」——主进程那边的闸门是兜底。
 */
function installLimitOf(settings: { concurrentDownloads?: number } | null | undefined): number {
  const raw = Number(settings?.concurrentDownloads ?? 12);
  if (!Number.isFinite(raw)) return 12;
  return Math.min(32, Math.max(1, Math.trunc(raw)));
}

/** 下载记录的重试参数：主进程用它重放安装，这里反向认出这条记录属于哪条安装。 */
function jobParamsOf(job: DownloadJob): Record<string, unknown> | null {
  if (!job.resume) return null;
  try {
    const parsed: unknown = JSON.parse(job.resume);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 安装条目：一条安装排队、跑、结束的完整状态，界面上每一条都各自显示自己的进度。 */
type InstallPhase = "queued" | "running" | "done" | "failed" | "cancelled";

interface InstallEntry {
  key: string;
  /** 卡片用的「项目」key（provider:projectId），用来把进度挂回卡片。 */
  projectKey: string;
  provider: ModProviderId;
  projectId: string;
  fileId: string | null;
  instanceId: string;
  instanceName: string;
  kind: ModContentKind;
  title: string;
  fileName: string;
  installDependencies: boolean;
  phase: InstallPhase;
  error?: string;
}

/** 筛选记忆：版本/加载器/分辨率/分类按内容类型分别记在本地，不新增设置字段。 */
const FILTERS_KEY = "naiwa.res.filters";
/** 来源：一级选择，跨类型共用一份（类型是二级，来源不是） */
const SOURCE_KEY = "naiwa.res.source";
/** 收藏：本地记忆，暂不落库。 */
const FAVORITES_KEY = "naiwa.res.favorites";

interface StoredFilters {
  version: string;
  loader: string;
  resolution: string;
  categories: string[];
}

const DEFAULT_FILTERS: StoredFilters = { version: "", loader: "", resolution: "", categories: [] };

/**
 * 一级「来源」与它支持的二级「类型」。
 * 数据包没有后端接口，继续以 disabled 的占位标签出现（与改造前一致）。
 */
const SOURCE_TABS: Array<{ value: ModProviderId; labelKey: string; kinds: UiContentKind[] }> = [
  { value: "modrinth", labelKey: "pages.mods.sourceModrinth", kinds: ["modpack", "mod", "resourcepack", "datapack", "shader"] },
  { value: "minekuai", labelKey: "pages.mods.sourceMinekuai", kinds: ["modpack", "mod", "resourcepack", "shader", "map"] },
  { value: "curseforge", labelKey: "pages.mods.sourceCurseforge", kinds: ["modpack", "mod"] },
];

/** 某来源支持的二级类型：按 KIND_TABS 的顺序过滤，保证按钮顺序稳定。 */
function kindsForSource(source: ModProviderId): typeof KIND_TABS {
  const supported = SOURCE_TABS.find((item) => item.value === source)?.kinds ?? [];
  return KIND_TABS.filter((tab) => supported.includes(tab.value));
}

/** 读来源：只认具体站点；历史存过 "all" 或没存过的，默认落在 Modrinth。 */
function readSource(): ModProviderId {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    if (raw === "modrinth" || raw === "minekuai" || raw === "curseforge") return raw;
  } catch {
    // 隐私模式读不到：用默认值即可。
  }
  return "modrinth";
}

function writeSource(source: ModProviderId): void {
  try {
    localStorage.setItem(SOURCE_KEY, source);
  } catch {
    // 记不住来源不影响使用。
  }
}

function readFilters(kind: UiContentKind): StoredFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const all = JSON.parse(raw) as Record<string, Partial<StoredFilters>>;
    const stored = all[kind] ?? {};
    // 只取认识的字段：老版本存过 source，来源现在单独存一份，不再从筛选里读。
    return {
      version: stored.version ?? "",
      loader: stored.loader ?? "",
      resolution: stored.resolution ?? "",
      categories: Array.isArray(stored.categories) ? stored.categories : [],
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function writeFilters(kind: UiContentKind, filters: StoredFilters): void {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, Partial<StoredFilters>>) : {};
    all[kind] = filters;
    localStorage.setItem(FILTERS_KEY, JSON.stringify(all));
  } catch {
    // 隐私模式/配额满：记不住上次选择不影响使用，静默忽略。
  }
}

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(keys: string[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(keys));
  } catch {
    // 同上：收藏只是本地记忆。
  }
}

/** 卡片上的相对时间：后端补了 updatedAt 就显示，没有就不占位。 */
function updatedAtOf(mod: ModSearchResult): string | undefined {
  return (mod as ModSearchResult & { updatedAt?: string }).updatedAt;
}

function sortTime(mod: ModSearchResult): number {
  const iso = updatedAtOf(mod);
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * 已装判定口径（与主进程 normalizeSlug 同口径）：小写 + 去掉所有非字母数字。
 * 键里拼上内容类型：同一个项目在 mods 与 shaderpacks 里是两回事。
 */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function projectKey(kind: ModContentKind, projectId: string): string {
  return `${kind}:${normalizeKey(projectId)}`;
}

function installedFileKey(kind: ModContentKind, fileName: string): string {
  return `${kind}:${fileName.trim().toLowerCase()}`;
}

/** 候选资源（搜索卡片 / 详情面板）参与弱匹配的三把钥匙。 */
interface InstalledCandidate {
  projectId: string;
  slug?: string;
  title: string;
}

/** strong = 索引精确命中；weak = 磁盘扫描条目靠名字/文件名推出来的「疑似」。 */
interface InstalledMatch {
  strong: InstalledContentRef[];
  weak: InstalledContentRef[];
}

const EMPTY_MATCH: InstalledMatch = { strong: [], weak: [] };

interface ScanEntry {
  ref: InstalledContentRef;
  tokens: string[];
}

interface InstalledIndex {
  byProject: Map<string, InstalledContentRef[]>;
  files: Set<string>;
  scan: Map<ModContentKind, ScanEntry[]>;
}

/** 扫描条目的比对 token：modId、显示名、文件名主干（不含扩展名）。 */
function scanTokensOf(ref: InstalledContentRef): string[] {
  const stem = ref.fileName.replace(/\.[^.]+$/, "");
  return [ref.modId, ref.name, stem]
    .map((value) => normalizeKey(value ?? ""))
    .filter((token) => token.length > 0);
}

function candidateTokensOf(candidate: InstalledCandidate): string[] {
  return [candidate.projectId, candidate.slug ?? "", candidate.title]
    .map(normalizeKey)
    .filter((token) => token.length > 0);
}

/**
 * 弱匹配：token 完全相等最可信；否则要求两边都够长（≥4）才做互相包含，
 * 免得 "jei" 这种短词把一堆条目全命中。
 */
function isWeakMatch(refTokens: string[], candidateTokens: string[]): boolean {
  for (const token of refTokens) {
    if (candidateTokens.includes(token)) return true;
  }
  for (const refToken of refTokens) {
    if (refToken.length < 4) continue;
    for (const candidateToken of candidateTokens) {
      if (candidateToken.length < 4) continue;
      if (refToken.includes(candidateToken) || candidateToken.includes(refToken)) return true;
    }
  }
  return false;
}

function buildInstalledIndex(refs: InstalledContentRef[]): InstalledIndex {
  const byProject = new Map<string, InstalledContentRef[]>();
  const files = new Set<string>();
  const scan = new Map<ModContentKind, ScanEntry[]>();
  for (const ref of refs) {
    files.add(installedFileKey(ref.kind, ref.fileName));
    // 有 projectId 的才进强匹配表：扫描条目的 projectId 是空串。
    if (ref.projectId) {
      const key = projectKey(ref.kind, ref.projectId);
      const list = byProject.get(key);
      if (list) list.push(ref);
      else byProject.set(key, [ref]);
    }
    // 老数据没有 source 字段，于是再看 projectId 是否为空，两者任一成立就走弱匹配。
    if (ref.source === "scan" || !ref.projectId) {
      const list = scan.get(ref.kind) ?? [];
      list.push({ ref, tokens: scanTokensOf(ref) });
      scan.set(ref.kind, list);
    }
  }
  return { byProject, files, scan };
}

/** 命中的文件名（强优先），拼给角标 title 与面板提示用。 */
function hitFileNames(match: InstalledMatch): string {
  const hits = match.strong.length > 0 ? match.strong : match.weak;
  return hits.map((hit) => hit.fileName).join(" / ");
}

function matchIn(index: InstalledIndex, kind: ModContentKind, candidate: InstalledCandidate): InstalledMatch {
  const strong = candidate.projectId
    ? index.byProject.get(projectKey(kind, candidate.projectId)) ?? []
    : [];
  // 强命中就到此为止：同一个资源不该再被同时标成「疑似」。
  if (strong.length > 0) return { strong, weak: [] };
  const tokens = candidateTokensOf(candidate);
  const weak = (index.scan.get(kind) ?? [])
    .filter((entry) => isWeakMatch(entry.tokens, tokens))
    .map((entry) => entry.ref);
  return { strong: [], weak };
}

/** 收藏图标：只在资源卡片上用，画在页内免得给通用 icons 添语义。 */
function IconStar({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 3.6 2.6 5.3 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8Z" />
    </svg>
  );
}

export function ModsPage() {
  const { instances, currentInstance, setCurrentInstanceId, reloadInstances, settings, navigate } = useApp();
  // 资源页首屏：从挂载到第一帧渲染完成
  const mountedAt = useRef(0);
  if (mountedAt.current === 0) mountedAt.current = perfNow();
  useEffect(() => {
    window.requestAnimationFrame(() => perfSince("mods-page-first-render", mountedAt.current));
  }, []);
  const { push } = useToast();
  const tr = useT();
  /** 二级「类型」：默认模组；数据包因后端缺口禁用（是否出现由来源决定）。 */
  const [kind, setKind] = useState<UiContentKind>("mod");
  /** 一级「来源」：三个站点单选（不再有「所有来源」合并）。 */
  const [source, setSourceState] = useState<ModProviderId>(readSource);
  /** 一键清空筛选后置位：不再沿用实例的版本/加载器，避免实例版本把结果筛空。 */
  const [looseSearch, setLooseSearch] = useState(false);
  /** 详细筛选项：版本/加载器/分辨率/分类，按类型分别记在本地记忆中。 */
  const [filters, setFilters] = useState<StoredFilters>(() => readFilters("mod"));
  const [sort, setSort] = useState<ModSort>("relevance");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<ModSearchResult | null>(null);
  /**
   * 安装队列：一条安装一个条目，各自排队、各自显示进度，互不禁用。
   * 用 ref 镜像当前值，调度器（effect）与事件回调都读 ref，避免闭包读到旧队列。
   */
  const [installs, setInstalls] = useState<InstallEntry[]>([]);
  const installsRef = useRef<InstallEntry[]>([]);
  /** 已经启动过的条目：effect 重入时不会把同一条安装启动两遍。 */
  const startedInstalls = useRef(new Set<string>());
  /** 用户主动取消过的条目：取消后的失败帧要显示成「已取消」而不是「失败」。 */
  const cancelledInstalls = useRef(new Set<string>());
  /** 展开中的实例浮层：记下是哪张卡片 + 锚点按钮，浮层自己在 body 上定位。 */
  const [picker, setPicker] = useState<{ mod: ModSearchResult; anchor: HTMLElement } | null>(null);
  /** 卡片上的实例按钮，详情面板里点安装时按 key 取回锚点，把浮层开在对应卡片上。 */
  const pickerAnchors = useRef(new Map<string, HTMLButtonElement>());
  /** 整合包「安装并创建实例」的确认弹窗（进行中的条目在 installs 队列里）。 */
  const [packConfirm, setPackConfirm] = useState<ModSearchResult | null>(null);
  /** 下载记录快照：进度按记录自己的重试参数对回条目，谁的进度显示在谁身上。 */
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites());
  const [depsPrompt, setDepsPrompt] = useState<{ deps: ModDependency[]; title: string } | null>(null);
  const depsResolver = useRef<((choice: DepsChoice) => void) | null>(null);
  /** 「这个项目已经装过」确认框：待装的项目 + 已装的记录，等用户选覆盖还是取消。 */
  const [dupPrompt, setDupPrompt] = useState<{
    mod: ModSearchResult; match: InstalledMatch; incoming: string;
  } | null>(null);
  const dupResolver = useRef<((overwrite: boolean) => void) | null>(null);
  /**
   * 已装清单缓存是否已失效：安装成功后置位，直到新快照落地才复位。
   * 置位期间重复检测不再拿缓存当快路径，避免用旧快照判「没装过」。
   */
  const [installedStale, setInstalledStale] = useState(false);

  /** 实时翻译总开关：关掉后即使结果里带译名也回退原文。 */
  const translateMods = settings?.translateMods ?? true;

  const isMap = kind === "map";
  const isDatapack = kind === "datapack";
  /** 整合包装法是「新建实例」，卡片上没有实例下拉。 */
  const isModpack = kind === "modpack";
  /** 面板与文件列表只有后端支持的类型才会打开。 */
  const detailKind: ModContentKind = isBackendKind(kind) ? kind : "mod";
  const noInstance = instances.length === 0;
  const curseforgeReady = Boolean((settings?.curseforgeApiKey ?? "").trim());
  const noKey = source === "curseforge" && !curseforgeReady;
  /** 当前来源支持的二级类型（数据包仍是 disabled 占位）。 */
  const kindTabs = useMemo(() => kindsForSource(source), [source]);

  /** 左侧「当前实例」：第一项是空选择，允许不选实例只浏览。 */
  const instanceOptions = useMemo(
    () => [
      { value: "", label: tr("pages.mods.browseOnlyOption") },
      ...instances.map((item) => ({
        value: item.id,
        label: `${item.name} · ${item.mcVersion} ${loaderLabel(item.loader, tr)}`,
      })),
    ],
    [instances, tr],
  );

  const patch = (next: Partial<StoredFilters>) => {
    const merged = { ...filters, ...next };
    setFilters(merged);
    writeFilters(kind, merged);
  };

  /** 只保留当前类型用得上的筛选项：分辨率只属于资源包，加载器只属于模组/整合包。 */
  const sanitizeFilters = (next: StoredFilters, forKind: UiContentKind): StoredFilters => ({
    ...next,
    loader: showsLoader(forKind) ? next.loader : "",
    resolution: showsResolution(forKind) ? next.resolution : "",
  });

  /** 切换二级类型：清掉已打开的详情/下拉，并换成该标签上次的筛选（顺手滤掉不适用的项）。 */
  const changeKind = (next: UiContentKind) => {
    const tab = kindTabs.find((item) => item.value === next);
    if (!tab || tab.disabled) return;
    setKind(next);
    setFilters(sanitizeFilters(readFilters(next), next));
    setLooseSearch(false);
    setSelected(null);
    setPicker(null);
  };

  const selectSource = (next: ModProviderId) => {
    if (next === source) return;
    if (next === "curseforge" && !curseforgeReady) return;
    setSourceState(next);
    writeSource(next);
    setLooseSearch(false);
    setSelected(null);
    setPicker(null);
    // 当前类型不被新来源支持时，落到该来源的第一个类型（数据包这种占位标签跳过）。
    const tabs = kindsForSource(next);
    if (!tabs.some((tab) => tab.value === kind && !tab.disabled)) {
      const first = tabs.find((tab) => !tab.disabled);
      if (first) {
        setKind(first.value);
        setFilters(sanitizeFilters(readFilters(first.value), first.value));
      }
      return;
    }
    // 同类型留着，但把新来源不适用的筛选项清掉（分类由 categoryList 落地后再校验）。
    setFilters((prev) => sanitizeFilters(prev, kind));
  };

  /** 一键清空筛选：连实例版本/加载器也不再套用，否则老实例会把某些来源筛空。 */
  const clearFilters = () => {
    setFilters({ ...DEFAULT_FILTERS });
    writeFilters(kind, { ...DEFAULT_FILTERS });
    setLooseSearch(true);
    // 关键词也是「筛选」的一部分：只清版本/分类而留着关键词，用户会看到空态点了没反应。
    setQuery("");
    setSubmitted("");
    push(tr("pages.mods.filtersCleared"), "info");
  };

  const toggleCategory = (id: string) => {
    const categories = filters.categories.includes(id)
      ? filters.categories.filter((item) => item !== id)
      : [...filters.categories, id];
    patch({ categories });
  };

  const toggleFavorite = (key: string) => {
    const next = favorites.includes(key) ? favorites.filter((item) => item !== key) : [...favorites, key];
    setFavorites(next);
    writeFavorites(next);
  };

  /** 筛选项：版本/加载器/分辨率来自后端；地图与数据包不请求。 */
  const filterOptions = useAsync<ModFilterOptions>(
    () => (isBackendKind(kind) && !isMap
      ? api.mods.filterOptions(kind)
      : Promise.resolve({ versions: [], loaders: [], resolutions: [] } as ModFilterOptions)),
    [kind, isMap],
  );

  /** 分类列表跟随类型与来源。 */
  const categoryList = useAsync<ModCategory[]>(
    () => (isBackendKind(kind) && !isMap ? api.mods.categories(kind, source) : Promise.resolve([] as ModCategory[])),
    [kind, source, isMap],
  );

  /**
   * 分类 id 是「来源 + 类型」各自的：切来源/切类型后，旧来源选的分类可能在新来源下不存在，
   * 发出去就是一个空列表（事故形态）。分类列表落地后校验一次，把不存在的清掉并说明。
   */
  useEffect(() => {
    if (categoryList.loading || categoryList.error) return;
    const available = categoryList.data ?? [];
    if (available.length === 0 || filters.categories.length === 0) return;
    const ids = new Set(available.map((item) => item.id));
    const kept = filters.categories.filter((id) => ids.has(id));
    if (kept.length === filters.categories.length) return;
    const next = { ...filters, categories: kept };
    setFilters(next);
    writeFilters(kind, next);
    push(tr("pages.mods.categoriesPruned", { count: filters.categories.length - kept.length }), "info");
  }, [categoryList.loading, categoryList.error, categoryList.data, filters, kind, push]);

  // 存过 CurseForge 但 Key 被清掉：退回 Modrinth，避免停在一个点不动的来源上。
  useEffect(() => {
    if (settings === null) return;
    if (source === "curseforge" && !curseforgeReady) {
      setSourceState("modrinth");
      writeSource("modrinth");
    }
  }, [settings, source, curseforgeReady]);

  /** 显式筛选优先，其次沿用当前实例的版本与加载器；清空筛选后两者都不再兜底。 */
  const effectiveVersion = filters.version || (looseSearch ? "" : currentInstance?.mcVersion) || "";
  const effectiveLoader = filters.loader
    || (looseSearch ? "" : showsLoader(kind) ? currentInstance?.loader ?? "" : "");

  /** 一页拉多少条：首屏与「加载更多」共用同一个页大小。 */
  const SEARCH_PAGE_SIZE = 40;
  const MAPS_PAGE_SIZE = 20;
  /** 列表刷新的依赖清单：useAsync 与分页复位共用，保证两边永远同步。 */
  const searchDeps = [
    source, kind, submitted, effectiveVersion, effectiveLoader, filters.resolution, filters.categories.join(","),
    sort, tick, noKey, isMap,
  ];

  /** 当前筛选对应的搜索请求（首屏 offset=0，加载更多时 offset 递增）。 */
  const buildSearchRequest = useCallback((offset: number, searchKind: ModContentKind): KindSearchRequest => ({
    // 来源是单选按钮：provider 与 source 始终同一个站点，不再走「所有来源」合并。
    provider: source,
    source,
    query: submitted,
    kind: searchKind,
    gameVersion: effectiveVersion || undefined,
    loader: effectiveLoader ? (effectiveLoader as LoaderKind) : undefined,
    resolution: filters.resolution || undefined,
    limit: SEARCH_PAGE_SIZE,
    offset,
    sort,
  }), [effectiveLoader, effectiveVersion, filters.resolution, sort, source, submitted]);

  /**
   * 拉某一页：分类多选时每个分类各查一次再合并去重（去重键 provider:projectId，跨页同样有效）。
   * full = 这一页还是满的，说明后面可能还有。
   */
  const fetchSearchPage = useCallback(async (offset: number): Promise<{ items: ModSearchResult[]; full: boolean }> => {
    if (!isBackendKind(kind) || isMap || noKey) return { items: [], full: false };
    const request = buildSearchRequest(offset, kind);
    const categories = filters.categories;
    if (categories.length === 0) {
      const items = await api.mods.search(request);
      return { items, full: items.length >= SEARCH_PAGE_SIZE };
    }
    // 分类是多选、后端只认单个 category：每个分类各查一次再合并去重（每个分类都用同一个 offset）。
    const lists = await Promise.all(categories.map((category) => api.mods.search({ ...request, category })));
    const seen = new Set<string>();
    const merged: ModSearchResult[] = [];
    for (const item of lists.flat()) {
      const key = `${item.provider}:${item.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    // 任一分类这一页还是满的，就说明还有下一页可翻。
    return { items: merged, full: lists.some((list) => list.length >= SEARCH_PAGE_SIZE) };
  }, [buildSearchRequest, filters.categories, isMap, kind, noKey]);

  /** 首屏那页是不是满的（决定还有没有下一页）：先写 ref，等 data 落地再同步到 state。 */
  const firstPageFull = useRef(true);
  const search = useAsync(async () => {
    const page = await fetchSearchPage(0);
    firstPageFull.current = page.full;
    return page.items;
  }, searchDeps);

  // 「加载更多」的累积页单独放 state：首屏渲染路径与改造前完全一致。
  const [extraResults, setExtraResults] = useState<ModSearchResult[]>([]);
  const [nextOffset, setNextOffset] = useState(SEARCH_PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 任一筛选/刷新变化：清空累积页、offset 归零、hasMore 复位（与 useAsync 依赖同一份清单）。
  useEffect(() => {
    setExtraResults([]);
    setNextOffset(SEARCH_PAGE_SIZE);
    setReachedEnd(false);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, searchDeps);

  // 首屏结果落地：用它判断到底了没有。
  useEffect(() => {
    if (search.data === null) return;
    setNextOffset(SEARCH_PAGE_SIZE);
    setReachedEnd(!firstPageFull.current);
  }, [search.data]);

  const hasMore = !reachedEnd && !search.loading && search.data !== null;

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore || isMap || noKey || !isBackendKind(kind)) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchSearchPage(nextOffset);
      setExtraResults((prev) => [...prev, ...page.items]);
      setNextOffset((prev) => prev + SEARCH_PAGE_SIZE);
      if (!page.full) setReachedEnd(true);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchSearchPage, hasMore, isMap, kind, nextOffset, noKey, push]);

  // 滚到接近底部自动加载；按钮仍保留，作为手动兜底与无障碍入口。
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "240px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const files = useAsync(
    () => {
      if (selected === null) return Promise.resolve([] as ModFileInfo[]);
      const request: KindFilesRequest = {
        provider: selected.provider,
        projectId: selected.projectId,
        gameVersion: currentInstance?.mcVersion,
        loader: currentInstance?.loader,
        kind: detailKind,
        limit: 30,
      };
      return api.mods.files(request);
    },
    [selected?.projectId, detailKind, currentInstance?.mcVersion, currentInstance?.loader],
  );

  const maps = useAsync(
    () => (isMap ? api.mods.maps(submitted, 1, currentInstance?.id) : Promise.resolve([] as MapEntry[])),
    [isMap, submitted, currentInstance?.id, tick],
  );

  // 地图分页：第 1 页由上面的 useAsync 拉，之后按 page 递增追加。
  const [extraMaps, setExtraMaps] = useState<MapEntry[]>([]);
  const [nextMapPage, setNextMapPage] = useState(2);
  const [mapsLoadingMore, setMapsLoadingMore] = useState(false);
  const [mapsEnd, setMapsEnd] = useState(false);
  const mapsLoadingRef = useRef(false);
  const mapsSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setExtraMaps([]);
    setNextMapPage(2);
    setMapsEnd(false);
    setMapsLoadingMore(false);
    mapsLoadingRef.current = false;
  }, [isMap, submitted, currentInstance?.id, tick]);

  useEffect(() => {
    if (maps.data === null) return;
    setNextMapPage(2);
    setMapsEnd(maps.data.length < MAPS_PAGE_SIZE);
  }, [maps.data]);

  /** 第 1 页 + 追加页：按地图 id 去重。 */
  const allMaps = useMemo(() => {
    const seen = new Set<string>();
    const out: MapEntry[] = [];
    for (const item of [...(maps.data ?? []), ...extraMaps]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }, [extraMaps, maps.data]);

  const mapsHasMore = isMap && !mapsEnd && !maps.loading && maps.data !== null;

  const loadMoreMaps = useCallback(async () => {
    if (mapsLoadingRef.current || !mapsHasMore) return;
    mapsLoadingRef.current = true;
    setMapsLoadingMore(true);
    try {
      const page = await api.mods.maps(submitted, nextMapPage, currentInstance?.id);
      setExtraMaps((prev) => [...prev, ...page]);
      setNextMapPage((prev) => prev + 1);
      if (page.length < MAPS_PAGE_SIZE) setMapsEnd(true);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      mapsLoadingRef.current = false;
      setMapsLoadingMore(false);
    }
  }, [currentInstance?.id, mapsHasMore, nextMapPage, push, submitted]);

  useEffect(() => {
    const node = mapsSentinelRef.current;
    if (!node || !mapsHasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreMaps();
    }, { rootMargin: "240px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMoreMaps, mapsHasMore]);

  /**
   * 实例里已装的内容：只查当前实例（没选实例就是空，界面自然不显示任何标记）。
   * tick 让顶部「刷新」能手动校正；instances 跟着实例列表重载走——在实例抽屉里删掉
   * 光影/资源包后列表会重载，角标要跟着消失。
   */
  const installedRefs = useAsync(
    () => (currentInstance
      ? api.mods.installedContent(currentInstance.id)
      : Promise.resolve([] as InstalledContentRef[])),
    [currentInstance?.id, tick, instances],
  );

  /**
   * 同一份数据建三档索引：强匹配（项目键 → 索引条目）、文件键集合（这个文件已装）、
   * 弱匹配（扫描条目的 token 表）。索引缺记录的老文件只能靠扫描条目兜底。
   */
  const installedIndex = useMemo(() => buildInstalledIndex(installedRefs.data ?? []), [installedRefs.data]);

  /** 当前实例里这个候选资源的匹配结果；没选实例一律当作没装。 */
  const matchInstalled = (contentKind: ModContentKind, candidate: InstalledCandidate): InstalledMatch => (
    currentInstance ? matchIn(installedIndex, contentKind, candidate) : EMPTY_MATCH
  );
  const isInstalledFile = (contentKind: ModContentKind, fileName: string): boolean => (
    currentInstance ? installedIndex.files.has(installedFileKey(contentKind, fileName)) : false
  );

  // 新快照落地 = 缓存重新可信；此前（含刚安装完的那段窗口）都按旧数据/脏数据处理。
  useEffect(() => {
    if (installedRefs.data === null) return;
    setInstalledStale(false);
    perfSince("mods-page-installed-refs", mountedAt.current);
  }, [installedRefs.data]);

  /** 首屏页 + 累积页：按 provider:projectId 去重（跨页重复也能挡住）。 */
  const allResults = useMemo(() => {
    const seen = new Set<string>();
    const out: ModSearchResult[] = [];
    for (const item of [...(search.data ?? []), ...extraResults]) {
      const key = `${item.provider}:${item.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }, [extraResults, search.data]);

  /** 卡片列表：后端排序之外再兜一层本地排序，切换排序立即见效。 */
  const results = useMemo(() => {
    if (sort === "downloads") return [...allResults].sort((a, b) => b.downloads - a.downloads);
    if (sort === "updated") return [...allResults].sort((a, b) => sortTime(b) - sortTime(a));
    return allResults;
  }, [allResults, sort]);

  const sortedFiles = useMemo(() => {
    const list = files.data ?? [];
    return [...list].sort((a, b) => {
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });
  }, [files.data]);

  const submitSearch = () => setSubmitted(query.trim());
  const hardRefresh = () => setTick((value) => value + 1);

  /** 分类 chip 的显示文案：以后端给的分类名为准，找不到就退回 id。 */
  const categoryName = (id: string) => categoryList.data?.find((item) => item.id === id)?.name ?? id;

  /** 打开前置确认框并等用户选择（按钮点击走 resolveDeps）。 */
  const askDeps = (deps: ModDependency[], title: string) => new Promise<DepsChoice>((resolve) => {
    depsResolver.current = resolve;
    setDepsPrompt({ deps, title });
  });

  const resolveDeps = (choice: DepsChoice) => {
    const resolve = depsResolver.current;
    depsResolver.current = null;
    setDepsPrompt(null);
    resolve?.(choice);
  };

  /** 打开「已装过」确认框并等用户选择（按钮点击走 resolveDuplicate）。 */
  const askDuplicate = (
    mod: ModSearchResult, match: InstalledMatch, incoming: string,
  ) => new Promise<boolean>((resolve) => {
    dupResolver.current = resolve;
    setDupPrompt({ mod, match, incoming });
  });

  const resolveDuplicate = (overwrite: boolean) => {
    const resolve = dupResolver.current;
    dupResolver.current = null;
    setDupPrompt(null);
    resolve?.(overwrite);
  };

  /**
   * 目标实例里这个候选资源的强弱匹配。
   * 缓存只当快路径，判定永远有兜底：不是当前实例、缓存还没加载好（null）、缓存是空的、
   * 或刚安装完缓存已失效，都直接现查一次。否则「还没读好」会被当成「没装过」，
   * 覆盖确认框就被静默跳过了（真实事故）。
   */
  const duplicatesIn = async (
    instanceId: string, mod: ModSearchResult, contentKind: ModContentKind,
  ): Promise<InstalledMatch> => {
    // 正在重新拉取（loading）时也算缓存不可信：那次请求可能还在上一个安装之前发出。
    const cacheUsable = currentInstance?.id === instanceId && !installedStale && !installedRefs.loading;
    const cached = cacheUsable ? installedRefs.data : null;
    let refs: InstalledContentRef[];
    if (cached !== null && cached.length > 0) {
      refs = cached;
    } else {
      try {
        refs = await api.mods.installedContent(instanceId);
      } catch {
        // 不静默吞：用户要知道这次为什么没有重复提示。
        push(tr("pages.mods.dedupeFailed"), "info");
        return EMPTY_MATCH;
      }
    }
    const result = matchIn(buildInstalledIndex(refs), contentKind, {
      projectId: mod.projectId, slug: mod.slug, title: mod.title,
    });
    if (result.strong.length > 0 || result.weak.length > 0) {
      // 一行痕迹：用户回报「没弹框/弹错框」时能直接看到当次判定依据。
      const grade = result.strong.length > 0 ? "index" : "scan";
      console.info(`[dedupe] 命中重复安装提示 instance=${instanceId} grade=${grade} files=${hitFileNames(result)}`);
    }
    return result;
  };

  /**
   * 安装前的必需前置检查：有必需前置才弹框。
   * 返回 true = 连带安装前置，false = 只装本体，null = 用户取消（不安装）。
   * 查询失败不阻断安装，提示一行后只装本体。
   */
  const confirmDependencies = async (
    mod: ModSearchResult,
    instance: InstanceMeta,
    file: ModFileInfo | null,
    kind: ModContentKind,
  ): Promise<boolean | null> => {
    let deps: ModDependency[];
    try {
      // 带上 kind：光影的必需前置由主进程按内置规则补充，资源包也可能声明前置。
      deps = await api.mods.dependencies(mod.provider, mod.projectId, instance.id, file?.fileId, kind);
    } catch {
      push(tr("pages.mods.depsCheckFailed"), "info");
      return false;
    }
    const required = deps.filter((dep) => dep.required);
    if (required.length === 0) return false;
    // 标题跟随列表：开着实时翻译时用译名，否则用原文。
    const choice = await askDeps(required, (translateMods ? mod.titleZh : undefined) ?? mod.title);
    if (choice === "cancel") return null;
    return choice === "with";
  };

  // ---------- 安装队列（多条并发，各自的进度/状态互不影响） ----------

  /** 安装级并发上限：与主进程闸门读同一个设置，改设置立刻生效。 */
  const installLimit = installLimitOf(settings);
  const queuedCount = installs.filter((item) => item.phase === "queued").length;

  /** 队列状态的唯一写入口：先更新 ref 再进 state，调度器与回调永远看到最新的队列。 */
  const commitInstalls = (next: InstallEntry[]) => {
    installsRef.current = next;
    setInstalls(next);
  };

  const patchInstall = (key: string, patch: Partial<InstallEntry>) => {
    commitInstalls(installsRef.current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const entryOf = (provider: ModProviderId, projectId: string, fileId: string | null, instanceId: string) => {
    const key = installKeyOf(provider, projectId, fileId, instanceId);
    return installs.find((item) => item.key === key);
  };

  /** 这条安装是不是正占着「它自己」：排队与进行中才算忙，完成后按钮立即恢复可用。 */
  const isEntryBusy = (entry: InstallEntry | undefined): boolean =>
    entry?.phase === "queued" || entry?.phase === "running";

  /** 这个实例里该项目的任何一条安装是否还在跑（选择实例的下拉按它禁用，避免写同一个文件）。 */
  const busyInInstance = (provider: ModProviderId, projectId: string, instanceId: string): boolean =>
    installs.some((item) =>
      item.provider === provider
      && item.projectId === projectId
      && item.instanceId === instanceId
      && isEntryBusy(item),
    );

  /** 某条安装当前的百分比：取主进程那条下载记录的进度；没有记录（或在排队）就是 null。 */
  const progressOf = (entry: InstallEntry): number | null => {
    if (entry.phase === "done") return 100;
    if (entry.phase !== "running") return null;
    const job = jobOfEntry(entry);
    return job ? job.progress : null;
  };

  /** 下载记录里属于这条安装的那一条：按重试参数（来源/项目/文件/实例）反查，主进程保证归属正确。 */
  const jobOfEntry = (entry: InstallEntry): DownloadJob | undefined => {
    if (entry.kind === "modpack") return undefined;
    const matches = downloadJobs.filter((job) => {
      if (job.kind !== "content") return false;
      const params = jobParamsOf(job);
      if (!params) return false;
      return params.provider === entry.provider
        && params.projectId === entry.projectId
        && params.instanceId === entry.instanceId
        && (typeof params.fileId === "string" ? params.fileId : null) === entry.fileId;
    });
    // 列表按创建时间倒序：优先取正在跑的那条，否则取最新一条（重试过会留下多条同参记录）
    return matches.find((job) => job.status === "running") ?? matches[0];
  };

  /** 一条安装真正的执行体：只负责跑 + 收尾，队列调度与状态流转在外面。 */
  const startInstall = async (entry: InstallEntry) => {
    if (startedInstalls.current.has(entry.key)) return;
    startedInstalls.current.add(entry.key);
    patchInstall(entry.key, { phase: "running", error: undefined });
    try {
      if (entry.kind === "modpack") {
        const created = await api.mods.installModpack(entry.provider, entry.projectId, entry.fileId ?? undefined);
        patchInstall(entry.key, { phase: "done", title: created.name });
        push(tr("pages.mods.modpackCreated", { name: created.name }), "success");
        await reloadInstances();
        return;
      }
      const request: KindInstallRequest = {
        provider: entry.provider,
        projectId: entry.projectId,
        fileId: entry.fileId ?? undefined,
        instanceId: entry.instanceId,
        kind: entry.kind,
        installDependencies: entry.installDependencies,
      };
      const result = await api.mods.install(request);
      patchInstall(entry.key, { phase: "done", fileName: result.fileName });
      push(
        tr(
          result.installedDependencies.length > 0 ? "pages.mods.installedWithDeps" : "pages.mods.installedNoDeps",
          {
            name: result.fileName,
            instance: entry.instanceName,
            dir: KIND_DIR[entry.kind],
            deps: result.installedDependencies.join(", "),
          },
        ),
        "success",
      );
      // 先标记缓存失效（下一次点安装不会用旧快照判定），再重查一次让角标跟着变。
      setInstalledStale(true);
      installedRefs.reload();
    } catch (error: unknown) {
      if (cancelledInstalls.current.has(entry.key)) {
        patchInstall(entry.key, { phase: "cancelled" });
        return;
      }
      patchInstall(entry.key, { phase: "failed", error: errorMessage(error) });
      push(errorMessage(error), "error");
    } finally {
      startedInstalls.current.delete(entry.key);
    }
  };

  /**
   * 入队：目标已经在排队/进行中就不重复入队，直接返回那一条。
   * 「同一实例里同一个项目」算同一个目标：说明里挑出来的文件未必等于最佳版本，
   * 两条一起跑会同时写同一个目标文件，所以 fileId 未知（null）时按冲突处理。
   */
  const enqueueInstall = (entry: Omit<InstallEntry, "phase">): InstallEntry => {
    const current = installsRef.current;
    const existing = current.find((item) =>
      (item.phase === "queued" || item.phase === "running")
      && item.provider === entry.provider
      && item.projectId === entry.projectId
      && item.instanceId === entry.instanceId
      && (item.fileId === null || entry.fileId === null || item.fileId === entry.fileId),
    );
    if (existing) return existing;
    const next: InstallEntry = { ...entry, phase: "queued" };
    cancelledInstalls.current.delete(entry.key);
    commitInstalls([...current.filter((item) => item.key !== entry.key), next]);
    return next;
  };

  /** 取消：排队中的立刻出队；正在跑的走主进程记录终止（只停这一条安装）。 */
  const cancelInstall = async (entry: InstallEntry) => {
    if (entry.phase === "queued") {
      commitInstalls(installsRef.current.filter((item) => item.key !== entry.key));
      return;
    }
    if (entry.phase !== "running") return;
    cancelledInstalls.current.add(entry.key);
    patchInstall(entry.key, { phase: "cancelled" });
    const job = jobOfEntry(entry);
    if (!job) return;
    try {
      await api.downloads.cancel(job.id);
    } catch {
      // 记录可能已被清掉：安装本身仍会按 abort 收尾，这里不必再打扰用户
    }
  };

  const retryInstall = (entry: InstallEntry) => {
    cancelledInstalls.current.delete(entry.key);
    patchInstall(entry.key, { phase: "queued", error: undefined });
  };

  const dismissInstall = (key: string) => {
    cancelledInstalls.current.delete(key);
    commitInstalls(installsRef.current.filter((item) => item.key !== key));
  };

  /**
   * 调度器：每次队列或「同时下载数」变化都重新算一遍空槽位，按入队顺序启动。
   * 上限调小时不会打断正在跑的安装，只是不再放新的；调大时排队中的立刻补上。
   */
  useEffect(() => {
    const running = installs.filter((item) => item.phase === "running").length;
    const slots = Math.max(0, installLimit - running);
    if (slots === 0) return;
    const queued = installs.filter((item) => item.phase === "queued").slice(0, slots);
    for (const entry of queued) void startInstall(entry);
    // startInstall 只读 ref 里的最新队列，不必进依赖
  }, [installs, installLimit]);

  /** 下载记录订阅：进度帧的归属由主进程判定，界面只把记录对回条目。 */
  useEffect(() => {
    let alive = true;
    const off = api.downloads.onChanged((list) => {
      if (alive) setDownloadJobs(list);
    });
    void api.downloads.list().then((list) => {
      if (alive) setDownloadJobs(list);
    }).catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  /** 安装单个内容；file 为空时交给主进程挑该实例的最佳版本（卡片下拉走这条）。 */
  const installContent = async (mod: ModSearchResult, instance: InstanceMeta, file: ModFileInfo | null) => {
    if (!isBackendKind(kind)) return;
    // 同一项目装过任意版本（或扫描到疑似同一资源）就先问：取消即整单中止（一个 install
    // 请求都不发），覆盖才继续原流程。弱命中同样要问，只是文案不一样。
    const dupes = await duplicatesIn(instance.id, mod, kind);
    if (dupes.strong.length > 0 || dupes.weak.length > 0) {
      const overwrite = await askDuplicate(mod, dupes, file?.fileName ?? tr("pages.mods.bestPick"));
      if (!overwrite) return;
    }
    // 模组/光影/资源包都可能带必需前置；整合包与存档不查，由主进程按各自目录处理。
    const needsDeps = kind === "mod" || kind === "shader" || kind === "resourcepack";
    const installDependencies = needsDeps ? await confirmDependencies(mod, instance, file, kind) : false;
    // 用户取消前置 → 整单不入队
    if (installDependencies === null) return;
    enqueueInstall({
      key: installKeyOf(mod.provider, mod.projectId, file?.fileId ?? null, instance.id),
      projectKey: keyOf(mod),
      provider: mod.provider,
      projectId: mod.projectId,
      fileId: file?.fileId ?? null,
      instanceId: instance.id,
      instanceName: instance.name,
      kind,
      title: titleOf(mod),
      fileName: file?.fileName ?? "",
      installDependencies,
    });
  };

  /** 队列里最该在卡片上露面的那一条（正在跑优先，其次排队，再次失败）。 */
  const entryForProject = (projectKey: string): InstallEntry | undefined => {
    const list = installs.filter((item) => item.projectKey === projectKey);
    if (list.length === 0) return undefined;
    return list.slice().sort((a, b) => (PHASE_RANK[b.phase] ?? 1) - (PHASE_RANK[a.phase] ?? 1))[0];
  };
  /** 条目的状态文案：进度只显示它自己那条记录的百分比。 */
  const phaseText = (entry: InstallEntry): string => {
    switch (entry.phase) {
      case "queued":
        return tr("pages.mods.installQueued");
      case "running": {
        const percent = progressOf(entry);
        return percent === null
          ? (entry.kind === "modpack" ? tr("pages.mods.creatingInstance") : tr("pages.mods.installing"))
          : tr("pages.mods.installPercent", { percent });
      }
      case "done":
        return tr("pages.mods.installDone");
      case "cancelled":
        return tr("pages.mods.installCancelled");
      default:
        return tr("pages.mods.installFailed");
    }
  };

  /** 文件行的目标实例：整合包新建实例，没有目标实例，用固定后缀占位。 */
  const fileInstanceId = detailKind === "modpack" ? "" : (currentInstance?.id ?? "");
  /** 详情面板底部按钮对应的那条安装（装的是列表里第一个、也就是最匹配的那个文件）。 */
  const panelEntry = selected
    ? entryOf(selected.provider, selected.projectId, sortedFiles[0]?.fileId ?? null, fileInstanceId)
    : undefined;
  const panelInstalling = isEntryBusy(panelEntry);
  /** 详情面板当前项目在该实例的已装记录：整合包走「新建实例」，不参与判定。 */
  const selectedMatch = selected && detailKind !== "modpack"
    ? matchInstalled(detailKind, { projectId: selected.projectId, slug: selected.slug, title: selected.title })
    : EMPTY_MATCH;
  /** 详情面板当前项目的匹配分级：null = 没装过。 */
  const selectedGrade = selectedMatch.strong.length > 0 ? "index" : selectedMatch.weak.length > 0 ? "scan" : null;

  /** 确认框里的分级与待列出的记录：强命中优先，弱命中只用于「疑似」文案。 */
  const dupGrade = dupPrompt && dupPrompt.match.strong.length === 0 ? "scan" : "index";
  const dupHits = dupPrompt
    ? (dupPrompt.match.strong.length > 0 ? dupPrompt.match.strong : dupPrompt.match.weak)
    : [];

  /** 卡片/浮层共用的 key，与 data-res-card 一致。 */
  const keyOf = (mod: ModSearchResult) => `${mod.provider}:${mod.projectId}`;
  /** 列表上显示的标题：开着实时翻译时用译名，整合包新建实例也用它当名字。 */
  const titleOf = (mod: ModSearchResult) => (translateMods ? mod.titleZh : undefined) ?? mod.title;

  const closePicker = useCallback(() => setPicker(null), []);

  /** 打开某张卡片的实例浮层（锚点是卡片自己的按钮）。 */
  const openPicker = (mod: ModSearchResult, anchor: HTMLElement) => setPicker({ mod, anchor });

  /** 卡片下拉选实例：切到该实例并直接装最佳版本。 */
  const installInto = async (mod: ModSearchResult, instance: InstanceMeta) => {
    setPicker(null);
    setCurrentInstanceId(instance.id);
    await installContent(mod, instance, null);
  };

  /** 没有实例也能浏览：下拉里的「不安装，仅浏览」只打开详情看内容。 */
  const browseOnly = (mod: ModSearchResult) => {
    setPicker(null);
    setSelected(mod);
  };

  /**
   * 安装入口发现「没选实例」：提示一句并把这套装到哪里的选择权交回卡片。
   * 关闭详情面板 + 滚到该卡片 + 展开它的实例浮层。
   */
  const nudgeToPickInstance = (mod: ModSearchResult) => {
    push(tr("pages.mods.pickInstanceFirst"), "info");
    setSelected(null);
    const anchor = pickerAnchors.current.get(keyOf(mod));
    if (!anchor) return;
    anchor.scrollIntoView({ block: "center", behavior: "instant" });
    setPicker({ mod, anchor });
  };

  /**
   * 整合包：不需要选实例，入队后由主进程新建实例（名字取整合包名）。
   * 每个整合包是独立条目，互不阻塞；新建实例本身不写别人正在写的目录。
   */
  const installModpackAndCreate = (mod: ModSearchResult, fileId?: string) => {
    setPackConfirm(null);
    setPicker(null);
    enqueueInstall({
      key: installKeyOf(mod.provider, mod.projectId, fileId ?? null, ""),
      projectKey: keyOf(mod),
      provider: mod.provider,
      projectId: mod.projectId,
      fileId: fileId ?? null,
      instanceId: "",
      instanceName: "",
      kind: "modpack",
      title: titleOf(mod),
      fileName: "",
      installDependencies: false,
    });
  };

  /** 列表换了一批（搜索 / 刷新）时卡片会被重建，锚点可能已经不在，浮层跟着收起。 */
  useEffect(() => {
    if (!search.loading) return;
    setPicker(null);
  }, [search.loading]);

  /** 地图直链交给系统浏览器（启动器暂不接管存档下载）。 */
  const downloadMap = async (entry: MapEntry) => {
    if (!entry.downloadUrl) return;
    try {
      await api.app.openExternal(entry.downloadUrl);
      push(tr("pages.mods.mapLinkOpened"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const openMapsWeb = async () => {
    try {
      await api.app.openExternal(MAPS_WEB_URL);
      push(tr("pages.mods.mapsPageOpened"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const versionOptions = useMemo(
    () => [
      { value: "", label: tr("pages.mods.allVersions") },
      ...(filterOptions.data?.versions ?? []).map((value) => ({ value, label: value })),
    ],
    [filterOptions.data, tr],
  );
  const loaderOptions = useMemo(
    () => [
      { value: "", label: tr("pages.mods.allLoaders") },
      ...(filterOptions.data?.loaders ?? []).map((value) => ({ value, label: loaderOptionLabel(value, tr) })),
    ],
    [filterOptions.data, tr],
  );
  const resolutionOptions = useMemo(
    () => [
      { value: "", label: tr("pages.mods.allResolutions") },
      ...(filterOptions.data?.resolutions ?? []).map((value) => ({ value, label: value })),
    ],
    [filterOptions.data, tr],
  );
  const sortOptions = useMemo(
    () => SORT_OPTIONS_KEY.map((item) => ({ value: item.value, label: tr(item.labelKey) })),
    [tr],
  );
  /** 空态要写清楚的「当前筛选」：来源 + 版本 + 加载器 + 分辨率 + 分类。 */
  const activeFilterText = useMemo(() => {
    const parts: string[] = [];
    const sourceLabel = SOURCE_TABS.find((item) => item.value === source)?.labelKey ?? source;
    parts.push(tr("pages.mods.filterSource", { label: tr(sourceLabel) }));
    if (!isMap) {
      if (effectiveVersion) parts.push(tr("pages.mods.filterVersion", { version: effectiveVersion }));
      if (effectiveLoader) parts.push(tr("pages.mods.filterLoader", { loader: loaderOptionLabel(effectiveLoader, tr) }));
      if (filters.resolution) parts.push(tr("pages.mods.filterResolution", { resolution: filters.resolution }));
      if (filters.categories.length > 0) {
        const ids = new Set((categoryList.data ?? []).map((item) => item.id));
        parts.push(
          tr("pages.mods.filterCategories", {
            names: filters.categories.map((id) => (ids.has(id) ? categoryName(id) : id)).join(", "),
          }),
        );
      }
    }
    return parts.join(" · ");
  }, [source, isMap, effectiveVersion, effectiveLoader, filters.resolution, filters.categories, categoryList.data, tr]);


  const subtitle = isMap
    ? (currentInstance
      ? tr("pages.mods.mapSubtitleWithInstance", { name: currentInstance.name, mc: currentInstance.mcVersion })
      : tr("pages.mods.mapSubtitleNoInstance"))
    : (currentInstance
      ? tr("pages.mods.subtitleInstance", {
        kind: kindLabel(kind, tr),
        name: currentInstance.name,
        mc: currentInstance.mcVersion,
        loader: loaderLabel(currentInstance.loader, tr),
      })
      : tr("pages.mods.subtitleNoInstance"));

  const resultCount = isMap ? (maps.data ?? []).length : results.length;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{tr("pages.mods.pageTitle")}</h1>
          <p className="page-sub">{subtitle}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={hardRefresh} disabled={isMap ? maps.loading : search.loading}>
            <IconRefresh size={16} />
            {tr("pages.common.refresh")}
          </button>
        </div>
      </header>

      {/* 安装队列：每条安装自己的状态与进度，互不影响；排队中的条目可以直接取消。 */}
      {installs.length > 0 ? (
        <section
          className="res-queue"
          data-install-queue
          data-install-queued={queuedCount}
          style={{ display: "grid", gap: 8 }}
        >
          <div className="drawer-section-head">
            <span className="field-label" title={tr("pages.mods.installQueueTip")}>
              {tr("pages.mods.installQueueTitle")}
            </span>
            <span className="muted-text" data-install-limit={installLimit}>
              {tr("pages.mods.installQueueLimit", { limit: installLimit })}
              {queuedCount > 0 ? ` · ${tr("pages.mods.installQueuedCount", { count: queuedCount })}` : ""}
            </span>
          </div>
          <ul className="file-list">
            {installs.map((entry) => {
              const percent = progressOf(entry);
              return (
                <li
                  key={entry.key}
                  className="file-row"
                  data-install-row={entry.key}
                  data-install-phase={entry.phase}
                >
                  <div className="file-main">
                    <div className="file-title">
                      <span className="file-name" title={entry.title}>{entry.title}</span>
                      <span className="badge" data-install-state={entry.phase}>{phaseText(entry)}</span>
                      {entry.fileName ? <span className="muted-text">{entry.fileName}</span> : null}
                    </div>
                    <div className="file-meta">
                      <span>{entry.instanceName || tr("pages.mods.creatingInstance")}</span>
                      {percent !== null && entry.phase === "running" ? (
                        <span data-install-percent={percent}>{percent}%</span>
                      ) : null}
                      {entry.phase === "failed" && entry.error ? <span>{entry.error}</span> : null}
                    </div>
                  </div>
                  <div className="res-card-side">
                    {entry.phase === "queued" || entry.phase === "running" ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        data-install-cancel={entry.key}
                        onClick={() => void cancelInstall(entry)}
                      >
                        {tr("pages.common.cancel")}
                      </button>
                    ) : null}
                    {entry.phase === "failed" || entry.phase === "cancelled" ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        data-install-retry={entry.key}
                        onClick={() => retryInstall(entry)}
                      >
                        {tr("pages.mods.installRetry")}
                      </button>
                    ) : null}
                    {entry.phase === "done" || entry.phase === "failed" || entry.phase === "cancelled" ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        data-install-dismiss={entry.key}
                        onClick={() => dismissInstall(entry.key)}
                      >
                        {tr("pages.mods.installDismiss")}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="res-switcher">
        {/* 一级：来源单选。没配 Key 的 CurseForge 直接禁用，并在 title 里说明原因。 */}
        <div className="source-tabs" role="tablist" aria-label={tr("pages.mods.sourceTabsAria")}>
          {SOURCE_TABS.map((tab) => {
            const disabled = tab.value === "curseforge" && !curseforgeReady;
            const kindCount = tab.kinds.filter((item) => item !== "datapack").length;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={tab.value === source}
                aria-disabled={disabled ? true : undefined}
                className={`source-tab ${tab.value === source ? "active" : ""} ${disabled ? "is-disabled" : ""}`.trim()}
                data-source-tab={tab.value}
                data-source-disabled={disabled ? "1" : undefined}
                title={disabled
                  ? tr("pages.mods.cfKeyTabTitle")
                  : tr("pages.mods.sourceTabTitle", { label: tr(tab.labelKey) })}
                disabled={disabled}
                onClick={() => selectSource(tab.value)}
              >
                {tr(tab.labelKey)}
                <span className="source-tab-count" data-source-kinds={kindCount}>
                  {tr("pages.mods.kindCount", { count: kindCount })}
                </span>
              </button>
            );
          })}
          <span className="source-hint" data-source-hint>
            {source === "minekuai"
              ? tr("pages.mods.sourceHintZh")
              : source === "curseforge"
                ? tr("pages.mods.sourceHintCf")
                : tr("pages.mods.sourceHintEn")}
          </span>
        </div>

        {/* 二级：类型，只列当前来源支持的那几个（数据包在支持它的来源下仍是禁用占位）。 */}
        <div className="kind-tabs" role="tablist" aria-label={tr("pages.mods.kindTabsAria")}>
          {kindTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={tab.value === kind}
              aria-disabled={tab.disabled ? true : undefined}
              className={`kind-tab ${tab.value === kind ? "active" : ""} ${tab.disabled ? "is-disabled" : ""}`.trim()}
              data-kind-tab={tab.value}
              data-kind-disabled={tab.disabled ? "1" : undefined}
              title={tab.hintKey ? tr(tab.hintKey) : undefined}
              disabled={tab.disabled}
              onClick={() => changeKind(tab.value)}
            >
              {tr(tab.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="mods-layout">
        <aside className="mods-aside res-aside">
          {!isMap ? (
            <>
              <div className="aside-block">
                <span className="field-label">{tr("pages.mods.versionLabel")}</span>
                <Select
                  value={filters.version}
                  options={versionOptions}
                  onChange={(value) => patch({ version: value })}
                  keepEmpty
                  ariaLabel={tr("pages.mods.versionLabel")}
                />
              </div>

              {showsLoader(kind) ? (
                <div className="aside-block">
                  <span className="field-label">{tr("pages.mods.loaderLabelText")}</span>
                  <Select
                    value={filters.loader}
                    options={loaderOptions}
                    onChange={(value) => patch({ loader: value })}
                    keepEmpty
                    ariaLabel={tr("pages.mods.loaderLabelText")}
                  />
                </div>
              ) : null}

              {showsResolution(kind) ? (
                <div className="aside-block">
                  <span className="field-label">{tr("pages.mods.resolutionLabel")}</span>
                  <Select
                    value={filters.resolution}
                    options={resolutionOptions}
                    onChange={(value) => patch({ resolution: value })}
                    keepEmpty
                    ariaLabel={tr("pages.mods.resolutionLabel")}
                  />
                </div>
              ) : null}

              <div className="aside-block">
                <span className="field-label">{tr("pages.mods.categoryLabel")}</span>
                {categoryList.loading ? <p className="aside-hint">{tr("pages.mods.readingCategories")}</p> : null}
                {categoryList.error ? <p className="aside-hint">{categoryList.error}</p> : null}
                <div className="cat-list" data-cat-list>
                  {(categoryList.data ?? []).map((category) => {
                    const active = filters.categories.includes(category.id);
                    return (
                      <button
                        key={category.id}
                        type="button"
                        className={`cat-item ${active ? "active" : ""}`.trim()}
                        data-cat={category.id}
                        aria-pressed={active}
                        onClick={() => toggleCategory(category.id)}
                      >
                        <span className="cat-name">{category.name}</span>
                        {typeof category.count === "number" ? <span className="cat-count">{category.count}</span> : null}
                      </button>
                    );
                  })}
                  {!categoryList.loading && (categoryList.data ?? []).length === 0 ? (
                    <p className="aside-hint">{tr("pages.mods.noCategories")}</p>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}

          <div className="aside-block">
            <span className="field-label">{tr("pages.mods.currentInstanceLabel")}</span>
            <Select
              value={currentInstance?.id ?? ""}
              options={instanceOptions}
              onChange={(value) => setCurrentInstanceId(value === "" ? null : value)}
              keepEmpty
              ariaLabel={tr("pages.mods.currentInstanceLabel")}
            />
            {currentInstance ? (
              <p className="aside-hint">
                {isMap
                  ? tr("pages.mods.mapInstanceHint")
                  : tr("pages.mods.kindInstanceHint", { kind: kindLabel(kind, tr) })}
              </p>
            ) : (
              <p className="aside-hint" data-instance-empty-hint>
                {noInstance ? tr("pages.mods.noInstancesBrowse") : tr("pages.mods.noInstanceChosen")}
              </p>
            )}
            {noInstance ? (
              <button type="button" className="link-btn" onClick={() => navigate("instances")}>
                {tr("pages.mods.createInstanceLink")}
              </button>
            ) : null}
          </div>
        </aside>

        <div className="mods-main">
          <div className="res-toolbar">
            <div className="search-wrap">
              <IconSearch size={16} className="search-icon" />
              <input
                className="input search-input"
                value={query}
                placeholder={tr(KIND_PLACEHOLDER_KEY[kind])}
                data-res-search
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={submitSearch}>
              {tr("pages.mods.searchAction")}
            </button>
            <span className="res-count" data-res-count>
              {isMap
                ? (maps.loading ? tr("pages.mods.searching") : tr("pages.mods.resultCount", { count: resultCount }))
                : (search.loading && results.length === 0
                  ? tr("pages.mods.searching")
                  : tr("pages.mods.resultCount", { count: resultCount }))}
            </span>
            <div className="res-sort">
              <span className="res-sort-label">{tr("pages.mods.sortLabel")}</span>
              <Select
                value={sort}
                options={sortOptions}
                onChange={(value) => setSort(value as ModSort)}
                ariaLabel={tr("pages.mods.sortLabel")}
              />
            </div>
          </div>

          {!isMap && filters.categories.length > 0 ? (
            <div className="res-chips" data-res-chips>
              <span className="res-chips-label">{tr("pages.mods.selectedCategories")}</span>
              {filters.categories.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="chip chip-active"
                  data-cat-chip={id}
                  onClick={() => toggleCategory(id)}
                  title={tr("pages.mods.removeCategoryTitle")}
                >
                  {categoryName(id)}
                  <IconClose size={12} />
                </button>
              ))}
            </div>
          ) : null}

          {isDatapack ? (
            <EmptyState
              title={tr("pages.mods.datapackUnsupportedTitle")}
              hint={tr("pages.mods.datapackUnsupportedHint")}
            />
          ) : null}

          {isMap ? (
            <>
              <p className="kind-notice" data-maps-notice>{tr(MAPS_NOTICE_KEY)}</p>

              {maps.loading ? <SkeletonRows count={4} /> : null}
              {maps.error ? <ErrorState message={maps.error} onRetry={maps.reload} /> : null}

              {!maps.loading && !maps.error && allMaps.length === 0 ? (
                <EmptyState
                  title={tr("pages.mods.noMapsTitle")}
                  hint={submitted ? tr("pages.mods.noMapsHint", { query: submitted }) : tr(KIND_EMPTY_HINT_KEY.map)}
                />
              ) : null}

              {allMaps.length > 0 ? (
                <MapCards
                  entries={allMaps}
                  mcVersion={currentInstance?.mcVersion}
                  onDownload={(entry) => void downloadMap(entry)}
                  onOpenWeb={() => void openMapsWeb()}
                />
              ) : null}

              {allMaps.length > 0 ? (
                <div className="load-more" data-mods-load-more="maps" data-loaded-count={allMaps.length}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-load-more-maps
                    data-load-more-state={mapsLoadingMore ? "loading" : mapsHasMore ? "idle" : "end"}
                    disabled={mapsLoadingMore || !mapsHasMore}
                    onClick={() => void loadMoreMaps()}
                  >
                    {mapsLoadingMore
                      ? tr("pages.mods.loadingMore")
                      : mapsHasMore
                        ? tr("pages.mods.loadMoreCount", { count: allMaps.length })
                        : tr("pages.mods.allLoadedCount", { count: allMaps.length })}
                  </button>
                  <div ref={mapsSentinelRef} className="load-more-sentinel" aria-hidden="true" />
                </div>
              ) : null}
            </>
          ) : null}

          {!isMap && noKey ? (
            <div className="guide-card">
              <h3 className="hint-title">{tr("pages.mods.cfKeyTitle")}</h3>
              <p className="hint-text">{tr("pages.mods.cfGuideText")}</p>
              <div className="guide-actions">
                <button type="button" className="btn btn-primary" onClick={() => navigate("settings")}>
                  {tr("pages.mods.goSettingsKey")}
                </button>
                <button type="button" className="btn btn-ghost" data-action="switch-source-modrinth" onClick={() => selectSource("modrinth")}>
                  {tr("pages.mods.switchModrinth")}
                </button>
              </div>
            </div>
          ) : null}

          {!isMap && !isDatapack && !noKey && search.loading ? <SkeletonRows count={5} /> : null}
          {!isMap && !isDatapack && !noKey && search.error ? <ErrorState message={search.error} onRetry={search.reload} /> : null}

          {!isMap && !isDatapack && !noKey && !search.loading && !search.error && results.length === 0 ? (
            <EmptyState
              title={
                submitted ? tr("pages.mods.noMatchTitle") : tr("pages.mods.noResultForKind", { kind: kindLabel(kind, tr) })
              }
              hint={tr("pages.mods.noMatchHint", {
                filters: activeFilterText,
                keyword: submitted ? tr("pages.mods.keywordSuffix", { keyword: submitted }) : "",
              })}
              action={(
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-action="clear-filters"
                  onClick={clearFilters}
                  title={tr("pages.mods.clearFiltersTitle")}
                >
                  {tr("pages.mods.clearFilters")}
                </button>
              )}
            />
          ) : null}

          {!isMap && !isDatapack && results.length > 0 ? (
            <div className="res-grid" data-res-grid>
              {results.map((mod) => {
                const key = `${mod.provider}:${mod.projectId}`;
                const titleZh = translateMods ? mod.titleZh : undefined;
                const summaryZh = translateMods ? mod.summaryZh : undefined;
                const favorite = favorites.includes(key);
                const open = picker !== null && keyOf(picker.mod) === key;
                const cardEntry = entryForProject(key);
                const creating = cardEntry?.phase === "queued" || cardEntry?.phase === "running";
                const updatedAt = updatedAtOf(mod);
                const badgeKey = isBackendKind(kind) ? KIND_BADGE_KEY[kind] : null;
                // 项目级判定：索引命中=已安装，扫描兜底命中=疑似已安装（可能只是同名）。
                const installedMatch = isBackendKind(kind)
                  ? matchInstalled(kind, { projectId: mod.projectId, slug: mod.slug, title: mod.title })
                  : EMPTY_MATCH;
                const installedGrade = installedMatch.strong.length > 0
                  ? "index"
                  : installedMatch.weak.length > 0 ? "scan" : null;
                return (
                  <article key={key} className="res-card" data-res-card={key}>
                    <button
                      type="button"
                      className="res-card-main"
                      data-res-open={key}
                      onClick={() => setSelected(mod)}
                    >
                      <img className="res-icon" src={mod.iconUrl} alt="" width={52} height={52} loading="lazy" />
                      <div className="res-card-body">
                        <div className="res-card-headline">
                          {/* 有译名时中文做主标题，英文原名降为副标。 */}
                          <h3 className="res-card-title" title={mod.title}>{titleZh ?? mod.title}</h3>
                          {badgeKey ? <span className="badge kind-badge" data-kind-badge>{tr(badgeKey)}</span> : null}
                          <span className={`badge res-source res-source-${mod.provider}`} data-res-source={mod.provider}>
                            {sourceBadge(mod.provider, tr)}
                          </span>
                          {cardEntry ? (
                            <span
                              className="badge"
                              data-res-install={cardEntry.phase}
                              title={tr("pages.mods.installQueueTitle")}
                            >
                              {phaseText(cardEntry)}
                            </span>
                          ) : null}
                          {installedGrade ? (
                            <span
                              className={`badge res-installed ${installedGrade === "scan" ? "is-scan" : ""}`.trim()}
                              data-res-installed={installedGrade}
                              title={tr(installedGrade === "index" ? "pages.mods.installedTitle" : "pages.mods.maybeInstalledTitle", {
                                files: hitFileNames(installedMatch),
                              })}
                            >
                              {installedGrade === "index" ? tr("pages.mods.installed") : tr("pages.mods.maybeInstalled")}
                            </span>
                          ) : null}
                        </div>
                        {titleZh ? <p className="res-card-orig" title={mod.title}>{mod.title}</p> : null}
                        <p className="res-card-desc">{summaryZh ?? mod.description}</p>
                        <div className="res-card-tags">
                          {mod.categories.slice(0, 4).map((category) => (
                            <span key={category} className="chip chip-sm">{category}</span>
                          ))}
                        </div>
                        <div className="res-card-stats">
                          <span className="res-stat" data-res-downloads>
                            <IconDownload size={14} />
                            {formatCount(mod.downloads, tr)}
                          </span>
                          <span className="res-stat" title={mod.author}>{mod.author}</span>
                          {updatedAt ? (
                            <span className="res-stat" data-res-updated>
                              {tr("pages.mods.updatedAt", { ago: formatAgo(updatedAt, tr) })}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>

                    <div className="res-card-side">
                      <button
                        type="button"
                        className={`fav-btn ${favorite ? "on" : ""}`.trim()}
                        data-res-fav={key}
                        aria-pressed={favorite}
                        aria-label={favorite ? tr("pages.mods.unfavorite") : tr("pages.mods.favorite")}
                        title={favorite ? tr("pages.mods.unfavoriteTitle") : tr("pages.mods.favoriteTitle")}
                        onClick={() => toggleFavorite(key)}
                      >
                        <IconStar filled={favorite} />
                      </button>

                      {/* 整合包不需要选实例：直接新建一个并安装，名字取整合包名。 */}
                      {isModpack ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          data-modpack-install={key}
                          disabled={creating}
                          onClick={() => setPackConfirm(mod)}
                        >
                          {creating ? phaseText(cardEntry as InstallEntry) : tr("pages.mods.installAndCreate")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`btn btn-sm ${noInstance ? "btn-ghost" : "btn-primary"}`.trim()}
                          data-instance-picker={key}
                          aria-haspopup="menu"
                          aria-expanded={open}
                          ref={(element) => {
                            if (element) pickerAnchors.current.set(key, element);
                            else pickerAnchors.current.delete(key);
                          }}
                          onClick={(event) => {
                            if (open) closePicker();
                            else openPicker(mod, event.currentTarget);
                          }}
                        >
                          {noInstance ? tr("pages.mods.noInstanceShort") : tr("pages.mods.selectInstance")}
                          <IconChevronDown size={14} />
                        </button>
                      )}

                      {noInstance && !isModpack ? (
                        <button type="button" className="link-btn res-create" data-res-create onClick={() => navigate("instances")}>
                          {tr("pages.mods.createInstanceLink")}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}

          {/* 加载更多：按钮给手动与无障碍入口，哨兵给滚到底自动加载；两路共用同一个 loadMore。 */}
          {!isMap && !isDatapack && !noKey && results.length > 0 ? (
            <div className="load-more" data-mods-load-more="search" data-loaded-count={results.length}>
              <button
                type="button"
                className="btn btn-ghost"
                data-load-more
                data-load-more-state={loadingMore ? "loading" : hasMore ? "idle" : "end"}
                data-loaded-count={results.length}
                disabled={loadingMore || !hasMore}
                onClick={() => void loadMore()}
              >
                {loadingMore
                  ? tr("pages.mods.loadingMore")
                  : hasMore
                    ? tr("pages.mods.loadMoreCount", { count: results.length })
                    : tr("pages.mods.allLoadedCount", { count: results.length })}
              </button>
              <div ref={sentinelRef} className="load-more-sentinel" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      </div>

      {/* 实例浮层 Portal 到 body、fixed 定位：任何卡片上的下拉都压在最上层，不被后面的卡片裁切。 */}
      {picker ? (
        <AnchoredMenu
          anchor={picker.anchor}
          onClose={closePicker}
          ariaLabel={tr("pages.mods.pickerAria")}
          menuKey={keyOf(picker.mod)}
        >
          <span className="res-menu-title">{noInstance ? tr("pages.mods.noUsableInstances") : tr("pages.mods.pickerAria")}</span>
          {instances.map((instance) => (
            <button
              key={instance.id}
              type="button"
              role="menuitem"
              className="res-menu-item"
              data-menu-instance={instance.id}
              disabled={busyInInstance(picker.mod.provider, picker.mod.projectId, instance.id)}
              onClick={() => void installInto(picker.mod, instance)}
            >
              <span className="res-menu-name">{instance.name}</span>
              <span className="res-menu-meta">{instance.mcVersion} · {loaderLabel(instance.loader, tr)}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="res-menu-item"
            data-menu-browse
            onClick={() => browseOnly(picker.mod)}
          >
            <span className="res-menu-name">{tr("pages.mods.browseOnly")}</span>
            <span className="res-menu-meta">{tr("pages.mods.openDetailHint")}</span>
          </button>
          {noInstance ? (
            <button
              type="button"
              role="menuitem"
              className="res-menu-item is-link"
              data-menu-create
              onClick={() => {
                closePicker();
                navigate("instances");
              }}
            >
              <span className="res-menu-name">{tr("pages.mods.createInstanceLink")}</span>
            </button>
          ) : null}
        </AnchoredMenu>
      ) : null}

      {selected ? (
        <ModDetailPanel
          open
          provider={selected.provider}
          projectId={selected.projectId}
          fallbackTitle={selected.title}
          titleZh={translateMods ? selected.titleZh : undefined}
          summaryZh={translateMods ? selected.summaryZh : undefined}
          installLabel={selectedGrade ? tr("pages.mods.reinstall") : tr(KIND_INSTALL_LABEL_KEY[detailKind])}
          onClose={() => setSelected(null)}
          onInstall={() => {
            // 整合包：新建实例，不需要选实例。
            if (detailKind === "modpack") {
              setPackConfirm(selected);
              return;
            }
            // 没选实例：提示一句并把实例选择交回卡片浮层。
            if (!currentInstance) {
              nudgeToPickInstance(selected);
              return;
            }
            void installContent(selected, currentInstance, sortedFiles[0] ?? null);
          }}
          installing={panelInstalling}
          installingLabel={panelEntry ? phaseText(panelEntry) : undefined}
          instanceName={currentInstance?.name}
          installHint={detailKind === "modpack"
            ? tr("pages.mods.modpackInstallHint", { name: titleOf(selected) })
            : selectedGrade === "index"
              ? tr("pages.mods.alreadyInstalledHint")
              : selectedGrade === "scan"
                ? tr("pages.mods.maybeInstalledHint", { files: hitFileNames(selectedMatch) })
                : undefined}
          noInstance={detailKind !== "modpack" && !currentInstance}
          filesSlot={
            <>
              {detailKind === "mod" && currentInstance?.loader === "vanilla" ? (
                <p className="hint-inline">{tr("pages.mods.vanillaWarning")}</p>
              ) : null}

              <div className="drawer-section-head">
                <span className="field-label">{tr("pages.mods.availableFiles")}</span>
                <span className="muted-text">
                  {currentInstance
                    ? tr("pages.mods.highlightMatch", {
                      mc: currentInstance.mcVersion,
                      loader: loaderLabel(currentInstance.loader, tr),
                    })
                    : ""}
                </span>
              </div>

              {files.loading ? <SkeletonRows count={4} /> : null}
              {files.error ? <ErrorState message={files.error} onRetry={files.reload} /> : null}

              {!files.loading && !files.error ? (
                <ul className="file-list">
                  {sortedFiles.map((file) => {
                    // 每个文件只关心自己那条安装：别的文件在装不会禁用这一行
                    const fileEntry = entryOf(selected.provider, selected.projectId, file.fileId, fileInstanceId);
                    const busy = isEntryBusy(fileEntry);
                    return (
                      <li key={file.fileId} className={`file-row ${file.exactMatch ? "is-match" : ""}`.trim()}>
                        <div className="file-main">
                          <div className="file-title">
                            <span className="file-name" title={file.fileName}>{file.fileName}</span>
                            <MatchTag exact={file.exactMatch} />
                            {isInstalledFile(detailKind, file.fileName) ? (
                              <span className="badge res-installed" data-file-installed="same">
                                {tr("pages.mods.fileInstalledSame")}
                              </span>
                            ) : selectedMatch.strong.length > 0 ? (
                              <span className="badge res-installed" data-file-installed="other">
                                {tr("pages.mods.fileInstalledOther")}
                              </span>
                            ) : selectedMatch.weak.length > 0 ? (
                              <span className="badge res-installed is-scan" data-file-installed="other-scan">
                                {tr("pages.mods.fileInstalledOtherScan")}
                              </span>
                            ) : null}
                          </div>
                          <div className="file-meta">
                            <ReleaseTypeTag type={file.releaseType} />
                            <span>{file.gameVersions.join(" / ")}</span>
                            <span>{file.loaders.join(" / ") || tr("pages.mods.universal")}</span>
                            <span>{formatDate(file.publishedAt)}</span>
                            <span>{tr("pages.mods.downloadCount", { count: formatCount(file.downloads, tr) })}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`btn btn-sm ${file.exactMatch ? "btn-primary" : "btn-ghost"}`.trim()}
                          data-file-install={file.fileId}
                          onClick={() => {
                            if (detailKind === "modpack") {
                              void installModpackAndCreate(selected, file.fileId);
                              return;
                            }
                            if (!currentInstance) {
                              nudgeToPickInstance(selected);
                              return;
                            }
                            void installContent(selected, currentInstance, file);
                          }}
                          disabled={busy}
                        >
                          <IconDownload size={15} />
                          {busy ? phaseText(fileEntry as InstallEntry) : tr(KIND_FILE_ACTION_KEY[detailKind])}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </>
          }
        />
      ) : null}

      {/* 必须排在抽屉之后：.overlay 同为 z-index 60，后渲染的才压在抽屉上面。 */}
      {depsPrompt ? (
        <ModDepsDialog open deps={depsPrompt.deps} projectTitle={depsPrompt.title} onChoose={resolveDeps} />
      ) : null}

      {/* 已装过同一项目（或磁盘上疑似同一资源）：默认不静默拦，交给用户决定是否覆盖。 */}
      {dupPrompt ? (
        <Modal
          open
          title={tr(dupGrade === "index" ? "pages.mods.dupIndexTitle" : "pages.mods.dupScanTitle")}
          subtitle={tr(dupGrade === "index" ? "pages.mods.dupIndexSubtitle" : "pages.mods.dupScanSubtitle", {
            instance: currentInstance?.name ?? "",
            name: titleOf(dupPrompt.mod),
          })}
          width={460}
          onClose={() => resolveDuplicate(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => resolveDuplicate(false)} data-action="dup-cancel">
                {tr("pages.common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => resolveDuplicate(true)} data-action="dup-overwrite">
                {tr("pages.mods.overwriteInstall")}
              </button>
            </>
          }
        >
          <p className="confirm-text">
            {tr(dupGrade === "index" ? "pages.mods.dupIndexRecords" : "pages.mods.dupDiskFiles")}
          </p>
          <ul className="dep-list" data-dup-list>
            {dupHits.map((hit) => (
              <li key={`${hit.kind}:${hit.fileName}`} className="dep-row" data-dup-row data-dup-file={hit.fileName}>
                <div className="dep-main">
                  <span className="dep-name">{hit.fileName}</span>
                  {hit.versionId ? (
                    <span className="dep-file">{tr("pages.mods.versionLabelShort", { version: hit.versionId })}</span>
                  ) : hit.name ? (
                    <span className="dep-file">{hit.name}</span>
                  ) : null}
                </div>
                <span className={`badge ${dupGrade === "index" ? "dep-badge-ok" : "dep-badge-builtin"}`}>
                  {dupGrade === "index" ? tr("pages.mods.installed") : tr("pages.mods.maybeSame")}
                </span>
              </li>
            ))}
          </ul>
          <p className="dep-hint">
            {tr(dupGrade === "index" ? "pages.mods.dupIndexNote" : "pages.mods.dupScanNote", {
              file: dupPrompt.incoming,
            })}
          </p>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={packConfirm !== null}
        title={tr("pages.mods.modpackConfirmTitle")}
        confirmText={tr("pages.mods.installAndCreate")}
        busy={false}
        message={packConfirm ? tr("pages.mods.modpackInstallHint", { name: titleOf(packConfirm) }) : ""}
        onCancel={() => setPackConfirm(null)}
        onConfirm={() => {
          if (packConfirm) void installModpackAndCreate(packConfirm);
        }}
      />
    </section>
  );
}
