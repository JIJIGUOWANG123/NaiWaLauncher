import { useEffect, useMemo, useRef, useState } from "react";
import type {
  InstanceMeta, LoaderKind, MapEntry, ModCategory, ModContentKind, ModDependency, ModFileInfo, ModFilterOptions,
  ModSearchResult,
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
import { ModDetailPanel } from "../components/ModDetailPanel";
import { ModDepsDialog, type DepsChoice } from "../components/ModDepsDialog";
import { MapCards } from "../components/MapCards";
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
  const { instances, currentInstance, setCurrentInstanceId, settings, navigate } = useApp();
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
  /** 当前展开「选择实例」下拉的卡片（provider:projectId）。 */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites());
  const [depsPrompt, setDepsPrompt] = useState<{ deps: ModDependency[]; title: string } | null>(null);
  const depsResolver = useRef<((choice: DepsChoice) => void) | null>(null);

  /** 实时翻译总开关：关掉后即使结果里带译名也回退原文。 */
  const translateMods = settings?.translateMods ?? true;

  const isMap = kind === "map";
  const isDatapack = kind === "datapack";
  /** 面板与文件列表只有后端支持的类型才会打开。 */
  const detailKind: ModContentKind = isBackendKind(kind) ? kind : "mod";
  const noInstance = instances.length === 0;
  const source = filters.source;
  const noKey = source === "curseforge" && !(settings?.curseforgeApiKey ?? "").trim();

  const instanceOptions = useMemo(
    () => instances.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.mcVersion} ${loaderLabel(item.loader)}`,
    })),
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
    setPickerFor(null);
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

  /**
   * 安装前的必需前置检查：有必需前置才弹框。
   * 返回 true = 连带安装前置，false = 只装本体，null = 用户取消（不安装）。
   * 查询失败不阻断安装，提示一行后只装本体。
   */
  const confirmDependencies = async (
    mod: ModSearchResult,
    instance: InstanceMeta,
    file: ModFileInfo | null,
  ): Promise<boolean | null> => {
    let deps: ModDependency[];
    try {
      deps = await api.mods.dependencies(mod.provider, mod.projectId, instance.id, file?.fileId);
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
    setInstalling({ projectId: mod.projectId, fileId: file?.fileId ?? null });
    try {
      // 前置只有模组需要确认；光影/资源包/整合包由主进程按各自目录处理。
      const installDependencies = kind === "mod" ? await confirmDependencies(mod, instance, file) : false;
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
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstalling(null);
    }
  };

  const panelInstalling = installing !== null && installing.projectId === (selected?.projectId ?? "");

  /** 卡片下拉选实例：切到该实例并直接装最佳版本。 */
  const installInto = async (mod: ModSearchResult, instance: InstanceMeta) => {
    setPickerFor(null);
    setCurrentInstanceId(instance.id);
    await installContent(mod, instance, null);
  };

  /** 没有实例也能浏览：下拉里的「不安装，仅浏览」只打开详情看内容。 */
  const browseOnly = (mod: ModSearchResult) => {
    setPickerFor(null);
    setSelected(mod);
  };

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

  /** 下拉打开时点空白处关闭；按钮与菜单自己 stopPropagation，免得刚开就被关。 */
  useEffect(() => {
    if (pickerFor === null) return undefined;
    const close = () => setPickerFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [pickerFor]);

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
      : "没有实例也能浏览；安装时在卡片上选目标实例，或先去创建一个实例");

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
              onChange={setCurrentInstanceId}
              placeholder={noInstance ? "暂无实例" : "选择实例"}
              disabled={noInstance}
              ariaLabel="当前实例"
            />
            {currentInstance ? (
              <p className="aside-hint">
                {isMap ? "地图按这个实例的版本标注适配性" : `${kindLabel(kind)}默认装进这个实例`}
              </p>
            ) : (
              <button type="button" className="link-btn" onClick={() => navigate("instances")}>
                去创建实例
              </button>
            )}
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
                const open = pickerFor === key;
                const updatedAt = updatedAtOf(mod);
                const badge = isBackendKind(kind) ? KIND_BADGE[kind] : null;
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

                      <div className="res-picker" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className={`btn btn-sm ${noInstance ? "btn-ghost" : "btn-primary"}`.trim()}
                          data-instance-picker={key}
                          onClick={() => setPickerFor(open ? null : key)}
                        >
                          {noInstance ? "无实例" : "选择实例"}
                          <IconChevronDown size={14} />
                        </button>
                        {open ? (
                          <div className="res-menu" role="menu" data-instance-menu={key}>
                            <span className="res-menu-title">{noInstance ? "还没有可用实例" : "安装到哪个实例"}</span>
                            {instances.map((instance) => (
                              <button
                                key={instance.id}
                                type="button"
                                role="menuitem"
                                className="res-menu-item"
                                data-menu-instance={instance.id}
                                disabled={installing !== null}
                                onClick={() => void installInto(mod, instance)}
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
                              onClick={() => browseOnly(mod)}
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
                                  setPickerFor(null);
                                  navigate("instances");
                                }}
                              >
                                <span className="res-menu-name">去创建实例</span>
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {noInstance ? (
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

      {selected ? (
        <ModDetailPanel
          open
          provider={selected.provider}
          projectId={selected.projectId}
          fallbackTitle={selected.title}
          titleZh={translateMods ? selected.titleZh : undefined}
          summaryZh={translateMods ? selected.summaryZh : undefined}
          installLabel={KIND_INSTALL_LABEL[detailKind]}
          onClose={() => setSelected(null)}
          onInstall={() => {
            if (currentInstance) void installContent(selected, currentInstance, sortedFiles[0] ?? null);
          }}
          installing={panelInstalling}
          instanceName={currentInstance?.name}
          noInstance={!currentInstance}
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
                    const busy = installing !== null
                      && installing.projectId === selected.projectId
                      && installing.fileId === file.fileId;
                    return (
                      <li key={file.fileId} className={`file-row ${file.exactMatch ? "is-match" : ""}`.trim()}>
                        <div className="file-main">
                          <div className="file-title">
                            <span className="file-name" title={file.fileName}>{file.fileName}</span>
                            <MatchTag exact={file.exactMatch} />
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
                          onClick={() => {
                            if (currentInstance) void installContent(selected, currentInstance, file);
                          }}
                          disabled={installing !== null || !currentInstance}
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
    </section>
  );
}
