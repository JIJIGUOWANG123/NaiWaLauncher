import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InstanceMeta, InstalledContentRef, LoaderKind, MapEntry, ModCategory, ModContentKind, ModDependency, ModFileInfo,
  ModFilterOptions, ModSearchResult,
} from "../../shared/types";
import { api } from "../lib/api";
import { formatAgo, formatCount, formatDate, loaderLabel } from "../lib/format";
import {
  KIND_BADGE, KIND_DIR, KIND_EMPTY_HINT, KIND_FILE_ACTION, KIND_INSTALL_LABEL, KIND_PLACEHOLDER, KIND_TABS,
  MAPS_NOTICE, MAPS_WEB_URL, SORT_OPTIONS, SOURCE_BADGE, SOURCE_OPTIONS, isBackendKind, kindLabel, loaderOptionLabel,
  showsLoader, showsResolution,
  type KindFilesRequest, type KindInstallRequest, type KindSearchRequest, type ModSort, type ModSourceFilter,
  type UiContentKind,
} from "../lib/modKind";
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

/** 筛选记忆：来源/版本/加载器/分辨率/分类按内容类型分别记在本地，不新增设置字段。 */
const FILTERS_KEY = "naiwa.res.filters";
/** 收藏：本地记忆，暂不落库。 */
const FAVORITES_KEY = "naiwa.res.favorites";

interface StoredFilters {
  source: ModSourceFilter;
  version: string;
  loader: string;
  resolution: string;
  categories: string[];
}

const DEFAULT_FILTERS: StoredFilters = { source: "all", version: "", loader: "", resolution: "", categories: [] };

function readFilters(kind: UiContentKind): StoredFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const all = JSON.parse(raw) as Record<string, Partial<StoredFilters>>;
    const stored = all[kind] ?? {};
    return {
      ...DEFAULT_FILTERS,
      ...stored,
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
  const { push } = useToast();
  /** 一级标签：默认模组；数据包因后端缺口禁用。 */
  const [kind, setKind] = useState<UiContentKind>("mod");
  /** 来源默认「所有来源」，其余筛选项跟着各标签的记忆走。 */
  const [filters, setFilters] = useState<StoredFilters>(() => readFilters("mod"));
  const [sort, setSort] = useState<ModSort>("relevance");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<ModSearchResult | null>(null);
  const [installing, setInstalling] = useState<{ projectId: string; fileId: string | null } | null>(null);
  /** 展开中的实例浮层：记下是哪张卡片 + 锚点按钮，浮层自己在 body 上定位。 */
  const [picker, setPicker] = useState<{ mod: ModSearchResult; anchor: HTMLElement } | null>(null);
  /** 卡片上的实例按钮，详情面板里点安装时按 key 取回锚点，把浮层开在对应卡片上。 */
  const pickerAnchors = useRef(new Map<string, HTMLButtonElement>());
  /** 整合包「安装并创建实例」：确认弹窗 + 进行中的卡片。 */
  const [packConfirm, setPackConfirm] = useState<ModSearchResult | null>(null);
  const [packBusy, setPackBusy] = useState<{ key: string; fileId: string | null } | null>(null);
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
  const source = filters.source;
  const noKey = source === "curseforge" && !(settings?.curseforgeApiKey ?? "").trim();

  /** 左侧「当前实例」：第一项是空选择，允许不选实例只浏览。 */
  const instanceOptions = useMemo(
    () => [
      { value: "", label: "不选择实例（仅浏览）" },
      ...instances.map((item) => ({
        value: item.id,
        label: `${item.name} · ${item.mcVersion} ${loaderLabel(item.loader)}`,
      })),
    ],
    [instances],
  );

  const patch = (next: Partial<StoredFilters>) => {
    const merged = { ...filters, ...next };
    setFilters(merged);
    writeFilters(kind, merged);
  };

  /** 切换一级标签：清掉已打开的详情/下拉，并换成该标签上次的筛选。 */
  const changeKind = (next: UiContentKind) => {
    const tab = KIND_TABS.find((item) => item.value === next);
    if (!tab || tab.disabled) return;
    setKind(next);
    setFilters(readFilters(next));
    setSelected(null);
    setPicker(null);
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

  /** 显式筛选优先，其次沿用当前实例的版本与加载器。 */
  const effectiveVersion = filters.version || currentInstance?.mcVersion || "";
  const effectiveLoader = filters.loader || (showsLoader(kind) ? currentInstance?.loader ?? "" : "");

  const search = useAsync(async () => {
    if (!isBackendKind(kind) || isMap || noKey) return [] as ModSearchResult[];
    const request: KindSearchRequest = {
      // source="all" 时主进程忽略 provider，这里给个中性值满足类型。
      provider: source === "all" ? "modrinth" : source,
      source,
      query: submitted,
      kind,
      gameVersion: effectiveVersion || undefined,
      loader: effectiveLoader ? (effectiveLoader as LoaderKind) : undefined,
      resolution: filters.resolution || undefined,
      limit: 40,
      sort,
    };
    const categories = filters.categories;
    if (categories.length === 0) return api.mods.search(request);
    // 分类是多选、后端只认单个 category：每个分类各查一次再合并去重。
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
  }, [
    source, kind, submitted, effectiveVersion, effectiveLoader, filters.resolution, filters.categories.join(","),
    sort, tick, noKey, isMap,
  ]);

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
    if (installedRefs.data !== null) setInstalledStale(false);
  }, [installedRefs.data]);

  /** 卡片列表：后端排序之外再兜一层本地排序，切换排序立即见效。 */
  const results = useMemo(() => {
    const list = search.data ?? [];
    if (sort === "downloads") return [...list].sort((a, b) => b.downloads - a.downloads);
    if (sort === "updated") return [...list].sort((a, b) => sortTime(b) - sortTime(a));
    return list;
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
        push("重复检查失败，本次未做重复提示", "info");
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
      push("前置检查失败，将只安装本体", "info");
      return false;
    }
    const required = deps.filter((dep) => dep.required);
    if (required.length === 0) return false;
    // 标题跟随列表：开着实时翻译时用译名，否则用原文。
    const choice = await askDeps(required, (translateMods ? mod.titleZh : undefined) ?? mod.title);
    if (choice === "cancel") return null;
    return choice === "with";
  };

  /** 安装单个内容；file 为空时交给主进程挑该实例的最佳版本（卡片下拉走这条）。 */
  const installContent = async (mod: ModSearchResult, instance: InstanceMeta, file: ModFileInfo | null) => {
    if (!isBackendKind(kind)) return;
    // 同一项目装过任意版本（或扫描到疑似同一资源）就先问：取消即整单中止（一个 install
    // 请求都不发），覆盖才继续原流程。弱命中同样要问，只是文案不一样。
    const dupes = await duplicatesIn(instance.id, mod, kind);
    if (dupes.strong.length > 0 || dupes.weak.length > 0) {
      const overwrite = await askDuplicate(mod, dupes, file?.fileName ?? "启动器挑选的最佳版本");
      if (!overwrite) return;
    }
    setInstalling({ projectId: mod.projectId, fileId: file?.fileId ?? null });
    try {
      // 模组/光影/资源包都可能带必需前置；整合包与存档不查，由主进程按各自目录处理。
      const needsDeps = kind === "mod" || kind === "shader" || kind === "resourcepack";
      const installDependencies = needsDeps ? await confirmDependencies(mod, instance, file, kind) : false;
      if (installDependencies === null) return;
      const request: KindInstallRequest = {
        provider: mod.provider,
        projectId: mod.projectId,
        fileId: file?.fileId,
        instanceId: instance.id,
        kind,
        installDependencies,
      };
      const result = await api.mods.install(request);
      const extra = result.installedDependencies.length > 0
        ? `，并安装了前置：${result.installedDependencies.join("、")}`
        : "";
      push(`${result.fileName} 已安装到「${instance.name}」的 ${KIND_DIR[kind]} 目录${extra}`, "success");
      // 先标记缓存失效（下一次点安装不会用旧快照判定），再重查一次让角标跟着变。
      setInstalledStale(true);
      installedRefs.reload();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstalling(null);
    }
  };

  const panelInstalling = installing !== null && installing.projectId === (selected?.projectId ?? "");
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
    push("请先选择要安装到的实例", "info");
    setSelected(null);
    const anchor = pickerAnchors.current.get(keyOf(mod));
    if (!anchor) return;
    anchor.scrollIntoView({ block: "center", behavior: "instant" });
    setPicker({ mod, anchor });
  };

  /** 整合包：不需要选实例，直接新建一个（名字取整合包名）再安装。 */
  const installModpackAndCreate = async (mod: ModSearchResult, fileId?: string) => {
    setPackConfirm(null);
    setPicker(null);
    setPackBusy({ key: keyOf(mod), fileId: fileId ?? null });
    try {
      const result = await api.mods.installModpack(mod.provider, mod.projectId, fileId);
      push(`已创建实例「${result.name}」并开始安装`, "success");
      await reloadInstances();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setPackBusy(null);
    }
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
      push("已在系统浏览器中打开地图下载链接", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const openMapsWeb = async () => {
    try {
      await api.app.openExternal(MAPS_WEB_URL);
      push("已在系统浏览器中打开麦块社区地图页", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const versionOptions = useMemo(
    () => [{ value: "", label: "全部版本" }, ...(filterOptions.data?.versions ?? []).map((value) => ({ value, label: value }))],
    [filterOptions.data],
  );
  const loaderOptions = useMemo(
    () => [{ value: "", label: "全部加载器" }, ...(filterOptions.data?.loaders ?? []).map((value) => ({ value, label: loaderOptionLabel(value) }))],
    [filterOptions.data],
  );
  const resolutionOptions = useMemo(
    () => [{ value: "", label: "全部分辨率" }, ...(filterOptions.data?.resolutions ?? []).map((value) => ({ value, label: value }))],
    [filterOptions.data],
  );
  const sortOptions = useMemo(() => SORT_OPTIONS.map((item) => ({ value: item.value, label: item.label })), []);
  const sourceOptions = useMemo(() => SOURCE_OPTIONS.map((item) => ({ value: item.value, label: item.label })), []);

  const subtitle = isMap
    ? (currentInstance
      ? `地图按「${currentInstance.name}」的 Minecraft ${currentInstance.mcVersion} 标注适配性`
      : "地图不依赖实例，直接浏览；下载需登录麦块社区")
    : (currentInstance
      ? `${kindLabel(kind)}可安装到「${currentInstance.name}」· Minecraft ${currentInstance.mcVersion} · ${loaderLabel(currentInstance.loader)}`
      : "未选择实例：可以照常浏览；安装时在卡片上选目标实例，整合包则直接新建实例");

  const resultCount = isMap ? (maps.data ?? []).length : results.length;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">资源</h1>
          <p className="page-sub">{subtitle}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={hardRefresh} disabled={isMap ? maps.loading : search.loading}>
            <IconRefresh size={16} />
            刷新
          </button>
        </div>
      </header>

      <div className="kind-tabs" role="tablist" aria-label="内容类型">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={tab.value === kind}
            aria-disabled={tab.disabled ? true : undefined}
            className={`kind-tab ${tab.value === kind ? "active" : ""} ${tab.disabled ? "is-disabled" : ""}`.trim()}
            data-kind-tab={tab.value}
            data-kind-disabled={tab.disabled ? "1" : undefined}
            title={tab.hint}
            disabled={tab.disabled}
            onClick={() => changeKind(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mods-layout">
        <aside className="mods-aside res-aside">
          <div className="aside-block">
            <span className="field-label">来源</span>
            <Select
              value={isMap ? "minekuai" : source}
              options={sourceOptions}
              onChange={(value) => patch({ source: value as ModSourceFilter })}
              disabled={isMap}
              ariaLabel="来源"
            />
            <p className="aside-hint" data-source-hint>
              {isMap
                ? "地图来自麦块社区（中文），下载需登录后到网页完成"
                : source === "all"
                  ? "同时搜索 Modrinth、CurseForge 与麦块社区"
                  : source === "minekuai"
                    ? "麦块社区提供中文译名与简介"
                    : "英文源没有中文译名，卡片显示原文"}
            </p>
          </div>

          {!isMap ? (
            <>
              <div className="aside-block">
                <span className="field-label">版本</span>
                <Select
                  value={filters.version}
                  options={versionOptions}
                  onChange={(value) => patch({ version: value })}
                  keepEmpty
                  ariaLabel="版本"
                />
              </div>

              {showsLoader(kind) ? (
                <div className="aside-block">
                  <span className="field-label">加载器</span>
                  <Select
                    value={filters.loader}
                    options={loaderOptions}
                    onChange={(value) => patch({ loader: value })}
                    keepEmpty
                    ariaLabel="加载器"
                  />
                </div>
              ) : null}

              {showsResolution(kind) ? (
                <div className="aside-block">
                  <span className="field-label">分辨率</span>
                  <Select
                    value={filters.resolution}
                    options={resolutionOptions}
                    onChange={(value) => patch({ resolution: value })}
                    keepEmpty
                    ariaLabel="分辨率"
                  />
                </div>
              ) : null}

              <div className="aside-block">
                <span className="field-label">类别</span>
                {categoryList.loading ? <p className="aside-hint">读取分类…</p> : null}
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
                    <p className="aside-hint">这个来源下没有分类</p>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}

          <div className="aside-block">
            <span className="field-label">当前实例</span>
            <Select
              value={currentInstance?.id ?? ""}
              options={instanceOptions}
              onChange={(value) => setCurrentInstanceId(value === "" ? null : value)}
              keepEmpty
              ariaLabel="当前实例"
            />
            {currentInstance ? (
              <p className="aside-hint">
                {isMap ? "地图按这个实例的版本标注适配性" : `${kindLabel(kind)}默认装进这个实例`}
              </p>
            ) : (
              <p className="aside-hint" data-instance-empty-hint>
                {noInstance ? "还没有实例：可以照常浏览，安装时先在卡片上建一个" : "未选择实例：可以照常浏览，安装时在卡片上选目标实例"}
              </p>
            )}
            {noInstance ? (
              <button type="button" className="link-btn" onClick={() => navigate("instances")}>
                去创建实例
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
                placeholder={KIND_PLACEHOLDER[kind]}
                data-res-search
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={submitSearch}>
              搜索
            </button>
            <span className="res-count" data-res-count>
              {isMap
                ? (maps.loading ? "搜索中…" : `${resultCount} 个结果`)
                : (search.loading && results.length === 0 ? "搜索中…" : `${resultCount} 个结果`)}
            </span>
            <div className="res-sort">
              <span className="res-sort-label">排序</span>
              <Select
                value={sort}
                options={sortOptions}
                onChange={(value) => setSort(value as ModSort)}
                ariaLabel="排序"
              />
            </div>
          </div>

          {!isMap && filters.categories.length > 0 ? (
            <div className="res-chips" data-res-chips>
              <span className="res-chips-label">已选分类</span>
              {filters.categories.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="chip chip-active"
                  data-cat-chip={id}
                  onClick={() => toggleCategory(id)}
                  title="点掉这个分类"
                >
                  {categoryName(id)}
                  <IconClose size={12} />
                </button>
              ))}
            </div>
          ) : null}

          {isDatapack ? (
            <EmptyState
              title="数据包暂不支持"
              hint="后端还没有数据包接口，先看看模组、资源包或整合包吧。"
            />
          ) : null}

          {isMap ? (
            <>
              <p className="kind-notice" data-maps-notice>{MAPS_NOTICE}</p>

              {maps.loading ? <SkeletonRows count={4} /> : null}
              {maps.error ? <ErrorState message={maps.error} onRetry={maps.reload} /> : null}

              {!maps.loading && !maps.error && (maps.data ?? []).length === 0 ? (
                <EmptyState
                  title="没有搜到地图"
                  hint={submitted ? `「${submitted}」没有结果，换个关键词试试。` : KIND_EMPTY_HINT.map}
                />
              ) : null}

              {(maps.data ?? []).length > 0 ? (
                <MapCards
                  entries={maps.data ?? []}
                  mcVersion={currentInstance?.mcVersion}
                  onDownload={(entry) => void downloadMap(entry)}
                  onOpenWeb={() => void openMapsWeb()}
                />
              ) : null}
            </>
          ) : null}

          {!isMap && noKey ? (
            <div className="guide-card">
              <h3 className="hint-title">CurseForge 需要 API Key</h3>
              <p className="hint-text">
                CurseForge 官方接口要求携带 API Key。请到设置页填写后返回；也可以直接用「所有来源」继续浏览。
              </p>
              <div className="guide-actions">
                <button type="button" className="btn btn-primary" onClick={() => navigate("settings")}>
                  去设置填写 Key
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => patch({ source: "all" })}>
                  改用所有来源
                </button>
              </div>
            </div>
          ) : null}

          {!isMap && !isDatapack && !noKey && search.loading ? <SkeletonRows count={5} /> : null}
          {!isMap && !isDatapack && !noKey && search.error ? <ErrorState message={search.error} onRetry={search.reload} /> : null}

          {!isMap && !isDatapack && !noKey && !search.loading && !search.error && results.length === 0 ? (
            <EmptyState
              title={`没有搜到${kindLabel(kind)}`}
              hint={submitted ? `「${submitted}」没有结果，换个关键词或换个来源试试。` : KIND_EMPTY_HINT[kind]}
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
                const creating = packBusy?.key === key;
                const updatedAt = updatedAtOf(mod);
                const badge = isBackendKind(kind) ? KIND_BADGE[kind] : null;
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
                          {badge ? <span className="badge kind-badge" data-kind-badge>{badge}</span> : null}
                          <span className={`badge res-source res-source-${mod.provider}`} data-res-source={mod.provider}>
                            {SOURCE_BADGE[mod.provider]}
                          </span>
                          {installedGrade ? (
                            <span
                              className={`badge res-installed ${installedGrade === "scan" ? "is-scan" : ""}`.trim()}
                              data-res-installed={installedGrade}
                              title={`${installedGrade === "index" ? "已安装" : "疑似已安装"}：${hitFileNames(installedMatch)}`}
                            >
                              {installedGrade === "index" ? "已安装" : "疑似已安装"}
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
                            {formatCount(mod.downloads)}
                          </span>
                          <span className="res-stat" title={mod.author}>{mod.author}</span>
                          {updatedAt ? (
                            <span className="res-stat" data-res-updated>更新于 {formatAgo(updatedAt)}</span>
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
                        aria-label={favorite ? "取消收藏" : "收藏"}
                        title={favorite ? "取消收藏（本地记忆）" : "收藏（本地记忆）"}
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
                          disabled={packBusy !== null}
                          onClick={() => setPackConfirm(mod)}
                        >
                          {creating ? "正在创建实例…" : "安装并创建实例"}
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
                          {noInstance ? "无实例" : "选择实例"}
                          <IconChevronDown size={14} />
                        </button>
                      )}

                      {noInstance && !isModpack ? (
                        <button type="button" className="link-btn res-create" data-res-create onClick={() => navigate("instances")}>
                          去创建实例
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {/* 实例浮层 Portal 到 body、fixed 定位：任何卡片上的下拉都压在最上层，不被后面的卡片裁切。 */}
      {picker ? (
        <AnchoredMenu
          anchor={picker.anchor}
          onClose={closePicker}
          ariaLabel="安装到哪个实例"
          menuKey={keyOf(picker.mod)}
        >
          <span className="res-menu-title">{noInstance ? "还没有可用实例" : "安装到哪个实例"}</span>
          {instances.map((instance) => (
            <button
              key={instance.id}
              type="button"
              role="menuitem"
              className="res-menu-item"
              data-menu-instance={instance.id}
              disabled={installing !== null}
              onClick={() => void installInto(picker.mod, instance)}
            >
              <span className="res-menu-name">{instance.name}</span>
              <span className="res-menu-meta">{instance.mcVersion} · {loaderLabel(instance.loader)}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="res-menu-item"
            data-menu-browse
            onClick={() => browseOnly(picker.mod)}
          >
            <span className="res-menu-name">不安装，仅浏览</span>
            <span className="res-menu-meta">打开详情看介绍</span>
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
              <span className="res-menu-name">去创建实例</span>
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
          installLabel={selectedGrade ? "重新安装" : KIND_INSTALL_LABEL[detailKind]}
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
          installing={panelInstalling || (detailKind === "modpack" && packBusy?.key === keyOf(selected) && packBusy.fileId === null)}
          installingLabel={detailKind === "modpack" ? "正在创建实例…" : undefined}
          instanceName={currentInstance?.name}
          installHint={detailKind === "modpack"
            ? `将新建实例「${titleOf(selected)}」并安装，可能需要几分钟`
            : selectedGrade === "index"
              ? "该实例里已装过这个资源，继续会再装一份"
              : selectedGrade === "scan"
                ? `实例里疑似已装过（${hitFileNames(selectedMatch)}），继续会再装一份`
                : undefined}
          noInstance={detailKind !== "modpack" && !currentInstance}
          filesSlot={
            <>
              {detailKind === "mod" && currentInstance?.loader === "vanilla" ? (
                <p className="hint-inline">
                  当前实例是原版，安装的模组不会生效。请把「当前实例」切换到 Fabric / Forge / NeoForge 实例。
                </p>
              ) : null}

              <div className="drawer-section-head">
                <span className="field-label">可用文件</span>
                <span className="muted-text">{currentInstance ? `高亮项匹配 ${currentInstance.mcVersion} ${loaderLabel(currentInstance.loader)}` : ""}</span>
              </div>

              {files.loading ? <SkeletonRows count={4} /> : null}
              {files.error ? <ErrorState message={files.error} onRetry={files.reload} /> : null}

              {!files.loading && !files.error ? (
                <ul className="file-list">
                  {sortedFiles.map((file) => {
                    const busy = detailKind === "modpack"
                      ? packBusy !== null && packBusy.key === keyOf(selected) && packBusy.fileId === file.fileId
                      : installing !== null && installing.projectId === selected.projectId && installing.fileId === file.fileId;
                    return (
                      <li key={file.fileId} className={`file-row ${file.exactMatch ? "is-match" : ""}`.trim()}>
                        <div className="file-main">
                          <div className="file-title">
                            <span className="file-name" title={file.fileName}>{file.fileName}</span>
                            <MatchTag exact={file.exactMatch} />
                            {isInstalledFile(detailKind, file.fileName) ? (
                              <span className="badge res-installed" data-file-installed="same">已装此版本</span>
                            ) : selectedMatch.strong.length > 0 ? (
                              <span className="badge res-installed" data-file-installed="other">已装其它版本</span>
                            ) : selectedMatch.weak.length > 0 ? (
                              <span className="badge res-installed is-scan" data-file-installed="other-scan">
                                疑似已装其它版本
                              </span>
                            ) : null}
                          </div>
                          <div className="file-meta">
                            <ReleaseTypeTag type={file.releaseType} />
                            <span>{file.gameVersions.join(" / ")}</span>
                            <span>{file.loaders.join(" / ") || "通用"}</span>
                            <span>{formatDate(file.publishedAt)}</span>
                            <span>{formatCount(file.downloads)} 次下载</span>
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
                          disabled={installing !== null || packBusy !== null}
                        >
                          <IconDownload size={15} />
                          {busy ? "安装中…" : KIND_FILE_ACTION[detailKind]}
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
          title={dupGrade === "index" ? "该实例已安装这个资源" : "实例里已存在看起来相同的资源"}
          subtitle={dupGrade === "index"
            ? `实例「${currentInstance?.name ?? ""}」里已经有「${titleOf(dupPrompt.mod)}」，继续会再装一份`
            : `没在安装索引里找到「${titleOf(dupPrompt.mod)}」，但磁盘上有名字相近的文件，继续会再装一份`}
          width={460}
          onClose={() => resolveDuplicate(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => resolveDuplicate(false)} data-action="dup-cancel">
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => resolveDuplicate(true)} data-action="dup-overwrite">
                覆盖安装
              </button>
            </>
          }
        >
          <p className="confirm-text">
            {dupGrade === "index" ? "索引里已装的记录：" : "磁盘上匹配到的文件："}
          </p>
          <ul className="dep-list" data-dup-list>
            {dupHits.map((hit) => (
              <li key={`${hit.kind}:${hit.fileName}`} className="dep-row" data-dup-row data-dup-file={hit.fileName}>
                <div className="dep-main">
                  <span className="dep-name">{hit.fileName}</span>
                  {hit.versionId ? (
                    <span className="dep-file">版本 {hit.versionId}</span>
                  ) : hit.name ? (
                    <span className="dep-file">{hit.name}</span>
                  ) : null}
                </div>
                <span className={`badge ${dupGrade === "index" ? "dep-badge-ok" : "dep-badge-builtin"}`}>
                  {dupGrade === "index" ? "已安装" : "疑似同款"}
                </span>
              </li>
            ))}
          </ul>
          <p className="dep-hint">
            {dupGrade === "index"
              ? `覆盖安装会写入 ${dupPrompt.incoming}；同名文件直接覆盖，旧版本文件不会自动删除。`
              : `这些文件只是名字/元数据相近，可能并不是同一个资源；覆盖安装会写入 ${dupPrompt.incoming}，旧文件不会自动删除。`}
          </p>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={packConfirm !== null}
        title="安装整合包"
        confirmText="安装并创建实例"
        busy={packBusy !== null}
        message={packConfirm ? `将新建实例「${titleOf(packConfirm)}」并安装，可能需要几分钟` : ""}
        onCancel={() => setPackConfirm(null)}
        onConfirm={() => {
          if (packConfirm) void installModpackAndCreate(packConfirm);
        }}
      />
    </section>
  );
}
