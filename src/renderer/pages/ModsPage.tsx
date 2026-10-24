import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DownloadJob, InstanceMeta, InstalledContentRef, InstalledModInfo, LoaderKind, ModCategory, ModContentKind, ModDependency,
  ModFileInfo, ModFilterOptions, ModProviderId, ModSearchResult, ServerEntry,
} from "../../shared/types";
import { api } from "../lib/api";
import { formatAgo, formatCount, formatDate, loaderLabel } from "../lib/format";
import {
  KIND_BADGE_KEY, KIND_DIR, KIND_FILE_ACTION_KEY, KIND_INSTALL_LABEL_KEY, KIND_PLACEHOLDER_KEY,
  KIND_TABS, SORT_OPTIONS_KEY, checkPluginPlatform, isBackendKind, kindLabel, loaderOptionLabel, serverCapabilitiesOf,
  serverContentKindOf, serverTargetGateFor, sourceBadge,
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
 * 一级「来源」与它真正支持的二级「类型」。
 * 数据包与地图两个入口已经撤掉：没有来源再列它们，标签栏自然只剩下面这些。
 * 插件（plugin）装进服务端的 plugins 目录，是唯一不进客户端实例的类型。
 */
const SOURCE_TABS: Array<{ value: ModProviderId; labelKey: string; kinds: UiContentKind[] }> = [
  { value: "modrinth", labelKey: "pages.mods.sourceModrinth", kinds: ["modpack", "mod", "resourcepack", "shader", "plugin"] },
  { value: "minekuai", labelKey: "pages.mods.sourceMinekuai", kinds: ["modpack", "mod", "resourcepack", "shader", "plugin"] },
  { value: "curseforge", labelKey: "pages.mods.sourceCurseforge", kinds: ["modpack", "mod"] },
];

/** 只展示、点不动的类型：CurseForge 还没有插件源，标签置灰并在 title 里说明原因。 */
const DISABLED_KINDS: Partial<Record<ModProviderId, UiContentKind[]>> = { curseforge: ["plugin"] };

/** 置灰标签的 title 文案。 */
const KIND_DISABLED_TITLE_KEY: Partial<Record<UiContentKind, string>> = { plugin: "pages.mods.pluginCurseforgeHint" };

/** 某来源列出来的二级类型：支持的 + 只展示的（后者置灰）。 */
function kindsShownFor(source: ModProviderId): UiContentKind[] {
  const supported = SOURCE_TABS.find((item) => item.value === source)?.kinds ?? [];
  return [...supported, ...(DISABLED_KINDS[source] ?? [])];
}

/** 某来源能点的二级类型：按 KIND_TABS 顺序过滤，保证按钮顺序稳定。 */
function kindsForSource(source: ModProviderId): typeof KIND_TABS {
  return KIND_TABS.filter((tab) => kindsShownFor(source).includes(tab.value));
}

/** 这个标签在当前来源下是不是置灰的（点不动）。 */
function kindDisabledFor(source: ModProviderId, value: UiContentKind): boolean {
  return (DISABLED_KINDS[source] ?? []).includes(value);
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

/** 页码区最多显示几个页码按钮。 */
const PAGER_WINDOW = 5;

/**
 * 页码窗口：最多 PAGER_WINDOW 个，当前页居中，越界时贴边。
 * last 为已知末页；接口不返回总数时传 null，按「当前页 + 2」估一个窗口。
 */
export function pagerPages(current: number, last: number | null): number[] {
  const cur = Math.max(1, Math.trunc(current));
  const edge = last === null ? cur + 2 : Math.max(cur, Math.trunc(last));
  const size = Math.min(PAGER_WINDOW, edge);
  // 当前页居中；靠近首页/末页时整窗贴边，避免出现 0 或越过末页的页码。
  const start = Math.max(1, Math.min(cur - Math.floor(size / 2), edge - size + 1));
  return Array.from({ length: size }, (_, index) => start + index);
}

/** 底部翻页条：上一页 / 页码 / 下一页。加载中只禁用，不清空列表。 */
function Pager(props: {
  page: number;
  /** 已知末页；null = 还不知道一共几页（接口不返回总数）。 */
  last: number | null;
  hasNext: boolean;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  const tr = useT();
  const pages = pagerPages(props.page, props.last);
  return (
    <nav
      className="pager"
      data-pager
      data-pager-page={props.page}
      data-pager-pages={props.last ?? "?"}
      aria-label={tr("pages.mods.pagerAria")}
    >
      <button
        type="button"
        className="btn btn-ghost btn-sm pager-step"
        data-pager-prev
        disabled={props.loading || props.page <= 1}
        onClick={() => props.onPage(props.page - 1)}
      >
        {tr("pages.mods.pagerPrev")}
      </button>
      <div className="pager-pages">
        {pages[0] > 1 ? <span className="pager-gap" aria-hidden="true">…</span> : null}
        {pages.map((item) => (
          <button
            key={item}
            type="button"
            className={`pager-page ${item === props.page ? "is-current" : ""}`.trim()}
            data-pager-page-btn={item}
            data-pager-current={item === props.page ? "" : undefined}
            aria-current={item === props.page ? "page" : undefined}
            disabled={props.loading}
            title={tr("pages.mods.pagerGoTitle", { page: item })}
            onClick={() => props.onPage(item)}
          >
            {item}
          </button>
        ))}
        {props.last !== null && pages[pages.length - 1] < props.last
          ? <span className="pager-gap" aria-hidden="true">…</span>
          : null}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm pager-step"
        data-pager-next
        disabled={props.loading || !props.hasNext}
        onClick={() => props.onPage(props.page + 1)}
      >
        {tr("pages.mods.pagerNext")}
      </button>
    </nav>
  );
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
  /** 二级「类型」：默认模组；能否出现由来源决定（插件在 CurseForge 下置灰）。 */
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
  /** 插件目标服务端 id（空串＝还没选）：只对插件类型有意义。 */
  const [serverId, setServerId] = useState("");
  /** 正在装插件的项目 key：只禁用那一条，别的卡片照常可点。 */
  const [pluginBusyKey, setPluginBusyKey] = useState<string | null>(null);
  /** 该服务端插件列表的刷新计数（安装成功后 +1）。 */
  const [pluginRefresh, setPluginRefresh] = useState(0);

  /** 实时翻译总开关：关掉后即使结果里带译名也回退原文。 */
  const translateMods = settings?.translateMods ?? true;

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
    if (!tab || kindDisabledFor(source, next)) return;
    setKind(next);
    // 新类型不能装服务端（光影/资源包/整合包）：目标退回实例，免得停在一个不可用的目标上。
    if (serverContentKindOf(next) === null) setServerId("");
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
    if (!tabs.some((tab) => tab.value === kind && !kindDisabledFor(next, tab.value))) {
      const first = tabs.find((tab) => !kindDisabledFor(next, tab.value));
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

  /** 筛选项：版本/加载器/分辨率来自后端；数据包没有后端接口，不请求。 */
  const filterOptions = useAsync<ModFilterOptions>(
    () => (isBackendKind(kind)
      ? api.mods.filterOptions(kind)
      : Promise.resolve({ versions: [], loaders: [], resolutions: [] } as ModFilterOptions)),
    [kind],
  );

  /** 分类列表跟随类型与来源。 */
  const categoryList = useAsync<ModCategory[]>(
    () => (isBackendKind(kind) ? api.mods.categories(kind, source) : Promise.resolve([] as ModCategory[])),
    [kind, source],
  );

  /** 开服列表：插件要装进某个服务端，选择器、目标名与已装判定都读它。 */
  const servers = useAsync<ServerEntry[]>(() => api.servers.list(), [tick]);
  /** 目标服务端：列表刷新后找不到（被删掉）就按「没选」处理。 */
  const pluginServer = useMemo(
    () => (servers.data ?? []).find((item) => item.meta.id === serverId) ?? null,
    [servers.data, serverId],
  );
  /** 目标：选了服务端就装服务端，否则沿用「当前实例」。 */
  const serverTarget = serverId !== "" && pluginServer !== null;
  const targetKind: "instance" | "server" = serverTarget ? "server" : "instance";
  const targetValue = serverTarget
    ? `server:${serverId}`
    : (currentInstance ? `instance:${currentInstance.id}` : "");
  /** 这个类型能不能装进服务端（资源包/光影/整合包只能装实例，服务端分组直接置灰）。 */
  const serverKindOk = serverContentKindOf(kind) !== null;
  /** 主进程给的能力表（拿不到就用核心推的兜底），决定这个类型能不能装进这个服务端。 */
  const serverCaps = useAsync(
    () => (serverTarget ? api.servers.capabilities(serverId) : Promise.resolve(null)),
    [serverTarget, serverId, tick],
  );
  const caps = serverCaps.data ?? (pluginServer ? serverCapabilitiesOf(pluginServer.meta.core) : null);
  const serverGate = caps && serverKindOk ? serverTargetGateFor(kind, caps) : null;
  const serverBlocked = serverTarget && serverGate !== null && !serverGate.allowed;
  const serverBlockHint = serverBlocked && serverGate?.reasonKey ? tr(serverGate.reasonKey) : null;
  /** 服务端插件接口（api.plugins）：装进 <服务端目录>/plugins。 */
  const plugins = api.plugins;
  /** 目标服务端对应目录（mods / plugins）里已装的东西：卡片与详情面板的「已安装」判定都读它。 */
  const installedPlugins = useAsync<InstalledModInfo[]>(
    () => {
      if (!serverTarget) return Promise.resolve([] as InstalledModInfo[]);
      if (kind === "plugin") return plugins.installed(serverId);
      if (kind === "mod") return api.servers.contentInstalled(serverId, "mod");
      return Promise.resolve([] as InstalledModInfo[]);
    },
    [serverTarget, serverId, kind, plugins, pluginRefresh, tick],
  );
  /** 服务端目录的条目类型：模组服看 mods，插件服看 plugins。 */
  const serverFileKind: ModContentKind = serverContentKindOf(kind) ?? "plugin";
  /** 已有的三档索引直接复用：服务端目录清单按 fileName / projectId 当成普通条目喂进去。 */
  const pluginIndex = useMemo(() => buildInstalledIndex((installedPlugins.data ?? []).map((item) => ({
    provider: item.provider ?? "modrinth",
    projectId: item.projectId ?? "",
    kind: serverFileKind,
    fileName: item.fileName,
    modId: item.modId,
    name: item.name,
  }))), [installedPlugins.data, serverFileKind]);
  /** 服务端目标的已装匹配：没选服务端一律当作没装。 */
  const pluginMatchOf = (mod: ModSearchResult): InstalledMatch => (
    serverTarget
      ? matchIn(pluginIndex, serverFileKind, { projectId: mod.projectId, slug: mod.slug, title: mod.title })
      : EMPTY_MATCH
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

  /** 每页固定 5 条：分页后列表只保留当前页，DOM 规模恒定。 */
  const SEARCH_PAGE_SIZE = 5;
  /** 列表刷新的依赖清单：useAsync 与分页复位共用，保证两边永远同步。 */
  const searchDeps = [
    source, kind, submitted, effectiveVersion, effectiveLoader, filters.resolution, filters.categories.join(","),
    sort, tick, noKey,
  ];

  /** 当前筛选对应的搜索请求：offset = (页码 - 1) × 每页条数，只拉当前页。 */
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

  /** 拉某一页：分类多选时每个分类各查一次再合并去重（去重键 provider:projectId）。 */
  const fetchSearchPage = useCallback(async (offset: number): Promise<ModSearchResult[]> => {
    if (!isBackendKind(kind) || noKey) return [];
    const request = buildSearchRequest(offset, kind);
    const categories = filters.categories;
    if (categories.length === 0) return api.mods.search(request);
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
    return merged;
  }, [buildSearchRequest, filters.categories, kind, noKey]);

  /**
   * 当前页码与筛选清单绑成一条记录：筛选一变 key 就对不上，页码自动回到 1，
   * 既不需要额外 effect，也不会先把旧页码的请求发出去再纠正。
   */
  const searchKey = searchDeps.join("|");
  const [pager, setPager] = useState<{ key: string; page: number }>({ key: searchKey, page: 1 });
  const page = pager.key === searchKey ? pager.page : 1;
  const goPage = useCallback((next: number) => {
    setPager({ key: searchKey, page: Math.max(1, next) });
  }, [searchKey]);

  /** 已知的末页（接口不返回总数，只有拿到「不满一页」才能确定）——同样按筛选清单失效。 */
  const [lastPage, setLastPage] = useState<{ key: string; page: number | null }>({ key: searchKey, page: null });
  const lastKnownPage = lastPage.key === searchKey ? lastPage.page : null;

  /** 当前 data 是哪一页的结果：空页回退只认「确实是这一页交回来的空结果」。 */
  const loadedPageRef = useRef(0);

  /** 只取当前页：offset 跟页码走，请求结果由 useAsync 的 alive 闸门丢弃过期的。 */
  const search = useAsync(() => {
    const target = page;
    return fetchSearchPage((target - 1) * SEARCH_PAGE_SIZE).then((items) => {
      loadedPageRef.current = target;
      return items;
    });
  }, [...searchDeps, page]);

  // 这一页不满 ⇒ 它就是末页，记下来给页码区贴边与「下一页」禁用用。
  useEffect(() => {
    if (search.loading || search.data === null || search.data.length >= SEARCH_PAGE_SIZE) return;
    setLastPage((prev) => (prev.key === searchKey && prev.page === page ? prev : { key: searchKey, page }));
  }, [page, search.data, search.loading, searchKey]);

  /** 末页判定不需要总数：当前页满就说明后面可能还有页。 */
  const hasNextPage = !search.loading && search.data !== null && search.data.length >= SEARCH_PAGE_SIZE;

  // 结果刚好是每页条数的整数倍时，「下一页」会翻进空页：退回上一页并把它记成末页。
  useEffect(() => {
    if (search.loading || search.data === null || search.data.length > 0 || page <= 1) return;
    if (loadedPageRef.current !== page) return;
    setLastPage({ key: searchKey, page: page - 1 });
    goPage(page - 1);
  }, [goPage, page, search.data, search.loading, searchKey]);

  /** 文件列表按目标适配：插件看服务端的游戏版本（服务端没有加载器概念）。 */
  const files = useAsync(
    () => {
      if (selected === null) return Promise.resolve([] as ModFileInfo[]);
      const request: KindFilesRequest = {
        provider: selected.provider,
        projectId: selected.projectId,
        gameVersion: serverTarget ? pluginServer?.meta.mcVersion : currentInstance?.mcVersion,
        loader: serverTarget ? undefined : currentInstance?.loader,
        kind: detailKind,
        limit: 30,
      };
      return api.mods.files(request);
    },
    [
      selected?.projectId, detailKind, currentInstance?.mcVersion, currentInstance?.loader,
      serverTarget, pluginServer?.meta.mcVersion,
    ],
  );

  /**
   * 实例里已装的内容：只查当前实例（没选实例就是空，界面自然不显示任何标记）。
   * tick 让顶部「刷新」能手动校正；instances 跟着实例列表重载走——在实例抽屉里删掉
   * 光影/资源包后列表会重载，角标要跟着消失。
   */
  const installedRefs = useAsync(
    () => (currentInstance && !serverTarget
      ? api.mods.installedContent(currentInstance.id)
      : Promise.resolve([] as InstalledContentRef[])),
    [currentInstance?.id, tick, instances, serverTarget],
  );

  /**
   * 同一份数据建三档索引：强匹配（项目键 → 索引条目）、文件键集合（这个文件已装）、
   * 弱匹配（扫描条目的 token 表）。索引缺记录的老文件只能靠扫描条目兜底。
   */
  const installedIndex = useMemo(() => buildInstalledIndex(installedRefs.data ?? []), [installedRefs.data]);

  /** 当前实例里这个候选资源的匹配结果；没选实例一律当作没装。 */
  const matchInstalled = (contentKind: ModContentKind, candidate: InstalledCandidate): InstalledMatch => (
    currentInstance && !serverTarget ? matchIn(installedIndex, contentKind, candidate) : EMPTY_MATCH
  );
  const isInstalledFile = (contentKind: ModContentKind, fileName: string): boolean => (
    serverTarget
      ? pluginIndex.files.has(installedFileKey(serverFileKind, fileName))
      : currentInstance ? installedIndex.files.has(installedFileKey(contentKind, fileName)) : false
  );

  // 新快照落地 = 缓存重新可信；此前（含刚安装完的那段窗口）都按旧数据/脏数据处理。
  useEffect(() => {
    if (installedRefs.data === null) return;
    setInstalledStale(false);
    perfSince("mods-page-installed-refs", mountedAt.current);
  }, [installedRefs.data]);

  /**
   * 当前页的卡片：按 provider:projectId 去重后只留这一页（上限 SEARCH_PAGE_SIZE 条）。
   * 分页取代累积，列表规模与滚动位置无关。
   */
  const results = useMemo(() => {
    const seen = new Set<string>();
    const out: ModSearchResult[] = [];
    for (const item of search.data ?? []) {
      const key = `${item.provider}:${item.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    // 后端排序之外再兜一层本地排序，切换排序立即见效。
    if (sort === "downloads") out.sort((a, b) => b.downloads - a.downloads);
    else if (sort === "updated") out.sort((a, b) => sortTime(b) - sortTime(a));
    return out.slice(0, SEARCH_PAGE_SIZE);
  }, [search.data, sort]);

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
    ? (detailKind === "plugin"
      ? pluginMatchOf(selected)
      : matchInstalled(detailKind, { projectId: selected.projectId, slug: selected.slug, title: selected.title }))
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

  /**
   * 装进服务端：plugin → <服务端>/plugins，mod → <服务端>/mods。
   * 不进客户端实例、也不进安装队列（单个文件就完事，失败了重点一次即可）。
   * 成功后提示并刷新该服务端对应目录的清单。
   */
  const installToServer = async (mod: ModSearchResult, file: ModFileInfo | null) => {
    if (!pluginServer) {
      push(tr("pages.mods.pluginPickServerFirst"), "info");
      return;
    }
    if (serverBlocked) {
      if (serverBlockHint) push(serverBlockHint, "info");
      return;
    }
    const target = serverContentKindOf(kind);
    if (target === null) {
      push(tr("pages.mods.serverTargetUnsupported"), "info");
      return;
    }
    setPluginBusyKey(keyOf(mod));
    try {
      if (target === "plugin") {
        await plugins.install({
          serverId: pluginServer.meta.id,
          provider: mod.provider,
          projectId: mod.projectId,
          fileId: file?.fileId,
        });
      } else {
        await api.servers.contentInstall({
          serverId: pluginServer.meta.id,
          kind: "mod",
          provider: mod.provider,
          projectId: mod.projectId,
          fileId: file?.fileId,
        });
      }
      push(tr("pages.mods.pluginInstalled", { name: pluginServer.meta.name }), "success");
      setPluginRefresh((value) => value + 1);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setPluginBusyKey(null);
    }
  };

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
    return parts.join(" · ");
  }, [source, effectiveVersion, effectiveLoader, filters.resolution, filters.categories, categoryList.data, tr]);


  /** 副标题：插件写目标服务端，其它类型照旧写当前实例。 */
  const subtitle = serverTarget
    ? (pluginServer
      ? tr("pages.mods.serverSubtitle", {
        name: pluginServer.meta.name,
        mc: pluginServer.meta.mcVersion,
        kind: kindLabel(kind, tr),
      })
      : tr("pages.mods.pluginSubtitleNoServer"))
    : (currentInstance
      ? tr("pages.mods.subtitleInstance", {
        kind: kindLabel(kind, tr),
        name: currentInstance.name,
        mc: currentInstance.mcVersion,
        loader: loaderLabel(currentInstance.loader, tr),
      })
      : tr("pages.mods.subtitleNoInstance"));

  const resultCount = results.length;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{tr("pages.mods.pageTitle")}</h1>
          <p className="page-sub">{subtitle}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={hardRefresh} disabled={search.loading}>
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
          {kindTabs.map((tab) => {
            const disabled = kindDisabledFor(source, tab.value);
            const titleKey = KIND_DISABLED_TITLE_KEY[tab.value];
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={tab.value === kind}
                aria-disabled={disabled ? true : undefined}
                className={`kind-tab ${tab.value === kind ? "active" : ""} ${disabled ? "is-disabled" : ""}`.trim()}
                data-kind-tab={tab.value}
                data-kind-option={tab.value}
                data-kind-disabled={disabled ? "1" : undefined}
                title={disabled && titleKey ? tr(titleKey) : undefined}
                disabled={disabled}
                onClick={() => changeKind(tab.value)}
              >
                {tr(tab.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mods-layout">
        <aside className="mods-aside res-aside">
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

          <div className="aside-block">
            {/* 目标：实例与服务端同在一个选择器里（服务端分组对光影/资源包/整合包置灰）。 */}
            <span className="field-label">{tr("pages.mods.targetLabel")}</span>
            <div
              className="select-wrap"
              data-target-select
              data-plugin-server-select
              data-target-kind={targetKind}
              data-target-id={serverTarget ? serverId : currentInstance?.id ?? ""}
            >
              <select
                className="input select"
                value={targetValue}
                aria-label={tr("pages.mods.targetLabel")}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("server:")) {
                    setServerId(value.slice("server:".length));
                    return;
                  }
                  setServerId("");
                  setCurrentInstanceId(value === "" ? null : value.slice("instance:".length));
                }}
              >
                <option value="">{tr("pages.mods.browseOnlyOption")}</option>
                <optgroup label={tr("pages.mods.targetInstances")}>
                  {instances.map((item) => (
                    <option
                      key={item.id}
                      value={`instance:${item.id}`}
                      data-target-kind="instance"
                      data-target-id={item.id}
                    >
                      {`${item.name} · ${item.mcVersion} ${loaderLabel(item.loader, tr)}`}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={tr("pages.mods.targetServers")} disabled={!serverKindOk}>
                  {(servers.data ?? []).map((item) => (
                    <option
                      key={item.meta.id}
                      value={`server:${item.meta.id}`}
                      data-target-kind="server"
                      data-target-id={item.meta.id}
                    >
                      {`${item.meta.name} · ${item.meta.mcVersion} · ${item.meta.core}`}
                    </option>
                  ))}
                </optgroup>
              </select>
              <IconChevronDown size={16} className="select-icon" />
            </div>

            {serverTarget && pluginServer ? (
              <>
                <p className="aside-hint" data-server-target-hint>
                  {tr(serverContentKindOf(kind) === "plugin" ? "pages.mods.pluginServerHint" : "pages.mods.modServerHint", {
                    name: pluginServer.meta.name,
                  })}
                </p>
                {serverBlockHint ? (
                  <p className="aside-hint" data-server-target-blocked>{serverBlockHint}</p>
                ) : null}
              </>
            ) : currentInstance ? (
              <p className="aside-hint">{tr("pages.mods.kindInstanceHint", { kind: kindLabel(kind, tr) })}</p>
            ) : (
              <p className="aside-hint" data-instance-empty-hint>
                {noInstance ? tr("pages.mods.noInstancesBrowse") : tr("pages.mods.noInstanceChosen")}
              </p>
            )}

            {!serverKindOk ? (
              <p className="aside-hint" data-server-target-unsupported>{tr("pages.mods.serverTargetUnsupported")}</p>
            ) : null}

            {noInstance && !serverKindOk ? (
              <button type="button" className="link-btn" onClick={() => navigate("instances")}>
                {tr("pages.mods.createInstanceLink")}
              </button>
            ) : null}
            {(servers.data ?? []).length === 0 ? (
              <button type="button" className="link-btn" onClick={() => navigate("servers")}>
                {tr("pages.mods.pluginCreateServerLink")}
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
              {search.loading && results.length === 0
                ? tr("pages.mods.searching")
                : tr("pages.mods.resultCount", { count: resultCount })}
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

          {filters.categories.length > 0 ? (
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

          {noKey ? (
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

          {/* 只有首屏（还没有任何数据）才铺骨架；换页时保留当前页，翻页条自己显示「加载中」的禁用态。 */}
          {!noKey && search.loading && search.data === null ? <SkeletonRows count={5} /> : null}
          {!noKey && search.error ? <ErrorState message={search.error} onRetry={search.reload} /> : null}

          {!noKey && !search.loading && !search.error && results.length === 0 ? (
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

          {results.length > 0 ? (
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
                // 插件看目标服务端的 plugins 目录，其它类型看当前实例。
                const installedMatch = serverTarget
                  ? pluginMatchOf(mod)
                  : isBackendKind(kind)
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
                      ) : serverTarget ? (
                        /* 服务端目标：模组装 mods、插件装 plugins，按核心能力决定能不能点。 */
                        <button
                          type="button"
                          className={`btn btn-sm ${serverBlocked || !pluginServer ? "btn-ghost" : "btn-primary"}`.trim()}
                          data-plugin-install={key}
                          data-server-install={key}
                          data-server-blocked={serverBlocked ? "1" : undefined}
                          disabled={!pluginServer || serverBlocked || pluginBusyKey === key}
                          title={!pluginServer
                            ? tr("pages.mods.pluginPickServerFirst")
                            : serverBlockHint ?? tr("pages.mods.serverInstall")}
                          onClick={() => void installToServer(mod, null)}
                        >
                          {pluginBusyKey === key ? tr("pages.mods.installing") : tr("pages.mods.serverInstall")}
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

                      {serverTarget && !pluginServer ? (
                        <span className="muted-text" data-plugin-need-server>
                          {tr("pages.mods.pluginPickServerFirst")}
                        </span>
                      ) : null}

                      {serverTarget && serverBlockHint ? (
                        <span className="muted-text" data-plugin-modded-server data-server-blocked-hint>
                          {serverBlockHint}
                        </span>
                      ) : null}

                      {!serverTarget && noInstance && !isModpack ? (
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

          {/* 翻页：上一页 / 页码 / 下一页；列表只保留当前页，滚动不再追加。 */}
          {!noKey && (results.length > 0 || page > 1) ? (
            <Pager
              page={page}
              last={lastKnownPage ?? (hasNextPage ? null : page)}
              hasNext={hasNextPage}
              loading={search.loading}
              onPage={goPage}
            />
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
            // 插件：装进上面选好的服务端（没选服务端就不发请求）。
            if (detailKind === "plugin") {
              void installToServer(selected, sortedFiles[0] ?? null);
              return;
            }
            // 没选实例：提示一句并把实例选择交回卡片浮层。
            if (!currentInstance) {
              nudgeToPickInstance(selected);
              return;
            }
            void installContent(selected, currentInstance, sortedFiles[0] ?? null);
          }}
          targetKind={targetKind}
          installing={panelInstalling || (serverTarget && pluginBusyKey === keyOf(selected))}
          installTitle={serverBlockHint ?? undefined}
          installingLabel={panelEntry ? phaseText(panelEntry) : undefined}
          instanceName={serverTarget ? pluginServer?.meta.name : currentInstance?.name}
          installHint={serverTarget
            ? (serverBlockHint
              ? serverBlockHint
              : pluginServer
              ? (selectedGrade === "index"
                ? tr("pages.modDetail.pluginInstalled", { name: pluginServer.meta.name, files: hitFileNames(selectedMatch) })
                : tr("pages.modDetail.pluginInstallTo", { name: pluginServer.meta.name }))
              : tr("pages.mods.pluginPickServerFirst"))
            : detailKind === "modpack"
              ? tr("pages.mods.modpackInstallHint", { name: titleOf(selected) })
              : selectedGrade === "index"
                ? tr("pages.mods.alreadyInstalledHint")
                : selectedGrade === "scan"
                  ? tr("pages.mods.maybeInstalledHint", { files: hitFileNames(selectedMatch) })
                  : undefined}
          installDisabled={serverTarget && (!pluginServer || serverBlocked)}
          noInstance={detailKind === "modpack" ? false : serverTarget ? !pluginServer : !currentInstance}
          filesSlot={
            <>
              {detailKind === "mod" && currentInstance?.loader === "vanilla" ? (
                <p className="hint-inline">{tr("pages.mods.vanillaWarning")}</p>
              ) : null}

              <div className="drawer-section-head">
                <span className="field-label">{tr("pages.mods.availableFiles")}</span>
                <span className="muted-text">
                  {serverTarget
                    ? (pluginServer
                      ? tr("pages.mods.pluginServerTarget", {
                        name: pluginServer.meta.name,
                        mc: pluginServer.meta.mcVersion,
                      })
                      : "")
                    : currentInstance
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
                    // 插件不进安装队列：这一行只看自己那条插件的安装状态。
                    const busy = serverTarget ? pluginBusyKey === keyOf(selected) : isEntryBusy(fileEntry);
                    // 文件自己的平台 vs 目标核心：不拦安装，只提示（用户可能就是想换核心）。
                    const platform = serverTarget && pluginServer
                      ? checkPluginPlatform(file.loaders, pluginServer.meta.core)
                      : null;
                    const platformWarn = Boolean(platform?.mismatch);
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
                            {platformWarn && pluginServer ? (
                              <span
                                className="badge plugin-platform-warn"
                                data-plugin-platform-warn={platform?.filePlatforms.join("/")}
                                title={tr("pages.mods.pluginPlatformWarn", {
                                  platforms: platform?.filePlatforms.join(" / ") ?? "",
                                  core: pluginServer.meta.core,
                                })}
                              >
                                {tr("pages.mods.pluginPlatformWarn", {
                                  platforms: platform?.filePlatforms.join(" / ") ?? "",
                                  core: pluginServer.meta.core,
                                })}
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
                          title={serverBlockHint
                            ? serverBlockHint
                            : platformWarn && pluginServer
                              ? tr("pages.mods.pluginPlatformWarn", {
                                platforms: platform?.filePlatforms.join(" / ") ?? "",
                                core: pluginServer.meta.core,
                              })
                              : undefined}
                          onClick={() => {
                            if (detailKind === "modpack") {
                              void installModpackAndCreate(selected, file.fileId);
                              return;
                            }
                            if (detailKind === "plugin") {
                              void installToServer(selected, file);
                              return;
                            }
                            if (!currentInstance) {
                              nudgeToPickInstance(selected);
                              return;
                            }
                            void installContent(selected, currentInstance, file);
                          }}
                          disabled={busy || (serverTarget && (!pluginServer || serverBlocked))}
                        >
                          <IconDownload size={15} />
                          {busy
                            ? (serverTarget ? tr("pages.mods.installing") : phaseText(fileEntry as InstallEntry))
                            : tr(KIND_FILE_ACTION_KEY[detailKind])}
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
