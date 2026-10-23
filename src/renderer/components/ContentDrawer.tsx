import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledModInfo, InstanceMeta } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { perfNow, perfSince } from "../lib/perf";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Drawer } from "./Drawer";
import { ConfirmDialog } from "./Modal";
import { TextInput } from "./Form";
import { EmptyState, ErrorState, SkeletonRows } from "./State";
import { IconRefresh, IconTrash, IconZap } from "./icons";

/** 光影/资源包分区：两种内容只有目录和文案不同，共用一套独立于模组分区的状态。 */
type PackKind = "shader" | "resourcepack";

const PACK_META: Record<PackKind, { dir: string; kindKey: string }> = {
  shader: { dir: "shaderpacks", kindKey: "pages.content.shaderPack" },
  resourcepack: { dir: "resourcepacks", kindKey: "pages.content.resourcePack" },
};

/** 搜索词归一化：小写并去掉所有空白，空串表示不过滤。 */
function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

/** 内容分区：模组 / 光影包 / 资源包共用一个分段控件与一个面板。 */
type ContentTab = "mod" | PackKind;

const CONTENT_TABS: Array<{ value: ContentTab; labelKey: string }> = [
  { value: "mod", labelKey: "pages.content.modUnit" },
  { value: "shader", labelKey: "pages.content.shaderPack" },
  { value: "resourcepack", labelKey: "pages.content.resourcePack" },
];

/** name / fileName / description 任一命中即保留；description 只有光影与资源包才有。 */
function matchSearch(item: InstalledModInfo, query: string): boolean {
  if (!query) return true;
  return [item.name, item.fileName, item.description]
    .some((field) => typeof field === "string" && normalizeSearch(field).includes(query));
}

/**
 * 单个光影/资源包分区：列表、检查更新、更新、删除。
 * 每个分区自己持有一套 state，切分区或换实例都不会读到别人的数据。
 */
function PackSection({
  open, instanceId, kind, push, hidden, onCount,
}: {
  open: boolean;
  instanceId: string | null;
  kind: PackKind;
  push: ReturnType<typeof useToast>["push"];
  /** 非激活类型只是不显示，组件仍保持挂载：切回来搜索词还在，也不会重新拉数据。 */
  hidden: boolean;
  /** 把本分区已加载的条数交给分段控件；null 表示还没加载完，此时不显示数字。 */
  onCount: (kind: PackKind, count: number | null) => void;
}) {
  const meta = PACK_META[kind];
  const tr = useT();
  const unit = tr(meta.kindKey);
  const [items, setItems] = useState<InstalledModInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstalledModInfo | null>(null);
  const [busyRemove, setBusyRemove] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!instanceId) return;
    const from = perfNow();
    setLoading(true);
    try {
      setItems(await api.mods.installed(instanceId, kind));
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      perfSince(`content-tab-load-${kind}`, from);
    }
  }, [instanceId, kind]);

  /**
   * 首次切到本分区才读盘：三个分区一起打开就并发扫三份目录，而用户通常只看模组那一个。
   * 只影响「第一次」，读过之后切来切去都不会再读（既有契约：切换不重新加载）。
   */
  const [activated, setActivated] = useState(false);
  useEffect(() => {
    if (!hidden) setActivated(true);
  }, [hidden]);

  // 换实例或重新打开时先清空，否则会短暂显示上一个实例的列表；搜索词也一并清掉，免得新实例被旧关键词过滤成空。
  useEffect(() => {
    if (!open || !instanceId || !activated) return;
    setItems(null);
    setError(null);
    setSearch("");
    void load();
  }, [open, instanceId, activated, load]);

  // 分段控件上的条数来自本分区自己的数据；还没加载完时上报 null（不显示 0）。
  useEffect(() => {
    onCount(kind, items === null ? null : items.length);
  }, [items, kind, onCount]);

  // 切到别的类型时收起删除确认：弹窗挂在面板里，面板 hidden 后它会跟着消失却留着状态。
  useEffect(() => {
    if (hidden) setRemoving(null);
  }, [hidden]);

  const query = useMemo(() => normalizeSearch(search), [search]);
  // 搜索只决定展示哪几行：items 始终是后端返回的全量，删除/刷新后按新数据重新过滤。
  const visible = useMemo(() => (items ?? []).filter((item) => matchSearch(item, query)), [items, query]);
  const updatable = useMemo(() => visible.filter((item) => item.update).length, [visible]);

  const checkUpdates = async () => {
    if (!instanceId) return;
    setChecking(true);
    try {
      const next = await api.mods.checkUpdates(instanceId, kind);
      setItems(next);
      const found = next.filter((item) => item.update).length;
      push(
        tr(found > 0 ? "pages.content.checkDoneUpdatable" : "pages.content.checkDoneNoUpdate", {
          total: next.length,
          unit,
          found,
        }),
        "success",
      );
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async (item: InstalledModInfo) => {
    if (!instanceId || !item.update) return;
    setUpdating(item.fileName);
    try {
      const result = await api.mods.update(instanceId, item.fileName, kind);
      push(tr("pages.content.updatedTo", { name: result.fileName }), "success");
      await load();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setUpdating(null);
    }
  };

  const confirmRemove = async () => {
    if (!instanceId || !removing) return;
    setBusyRemove(true);
    try {
      await api.mods.remove(instanceId, removing.fileName, kind);
      push(tr("pages.content.deleted", { name: removing.name ?? removing.fileName }), "success");
      setRemoving(null);
      await load();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusyRemove(false);
    }
  };

  return (
    <div className="detail-content-panel" data-pack-section={kind} data-content-panel={kind} hidden={hidden}>
      <div className="drawer-section-head">
        <span className="field-label">{unit}</span>
        <span className="muted-text" data-pack-stats>
          {items === null
            ? tr("pages.content.readingDir", { dir: meta.dir })
            : query
              ? (
                <>
                  {tr("pages.content.statTotal", { total: items.length })}
                  <span className="detail-match-count">{tr("pages.content.statMatched", { count: visible.length })}</span>
                  {tr("pages.content.statUpdatableTail", { count: updatable })}
                </>
              )
              : tr("pages.content.statPlain", { total: items.length, count: updatable })}
        </span>
      </div>

      <div className="detail-search-row">
        <TextInput
          type="search"
          className="detail-search-input"
          data-pack-search={kind}
          value={search}
          placeholder={tr("pages.content.searchInstalled", { unit })}
          aria-label={tr("pages.content.searchInstalled", { unit })}
          onChange={(event) => setSearch(event.target.value)}
          disabled={items === null}
        />
      </div>

      <div className="detail-mods-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-action="check-pack-updates"
          onClick={() => void checkUpdates()}
          disabled={checking || loading || items === null}
        >
          <IconZap size={15} />
          {checking ? tr("pages.content.checking") : tr("pages.content.checkUpdates")}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-action="reload-packs"
          onClick={() => void load()}
          disabled={loading || checking}
        >
          <IconRefresh size={15} />
          {tr("pages.common.refresh")}
        </button>
      </div>

      {loading && items === null ? <SkeletonRows count={3} /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {!error && items !== null && items.length === 0 ? (
        <EmptyState
          title={tr("pages.content.emptyTitle", { unit })}
          hint={tr("pages.content.emptyHint", { unit })}
        />
      ) : null}

      {!error && items !== null && items.length > 0 && visible.length === 0 ? (
        <EmptyState
          title={tr("pages.content.noMatchTitle", { unit })}
          hint={tr("pages.content.noMatchHint", { unit, query: search.trim() })}
          action={(
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-action="clear-pack-search"
              onClick={() => setSearch("")}
            >
              {tr("pages.content.clearSearch")}
            </button>
          )}
        />
      ) : null}

      {!error && items !== null && items.length > 0 && visible.length > 0 ? (
        <ul className="detail-mods-table" data-pack-table={kind}>
          <li className="detail-mods-row is-head is-packs" aria-hidden="true">
            <span>{tr("pages.content.colContent")}</span>
            <span>{tr("pages.content.colSize")}</span>
            <span className="detail-mods-ops">{tr("pages.content.colOps")}</span>
          </li>
          {visible.map((item) => (
            <li
              key={item.fileName}
              className={`detail-mods-row is-packs ${item.update ? "has-update" : ""}`}
              data-pack-file={item.fileName}
            >
              <div className="detail-mod-main">
                <span className="detail-mod-name" title={item.fileName}>{item.name ?? item.fileName}</span>
                {item.description
                  ? <span className="detail-mod-desc">{item.description}</span>
                  : <span className="detail-mod-file">{item.fileName}</span>}
                {item.update ? (
                  <span className="badge detail-update-tag">
                    {tr("pages.content.updatableTag", { version: item.update.versionLabel })}
                  </span>
                ) : null}
              </div>
              <span className="detail-mod-size">{formatBytes(item.sizeBytes)}</span>
              <div className="detail-mods-ops">
                <button
                  type="button"
                  className={`btn btn-sm ${item.update ? "btn-update-on" : "btn-ghost"}`}
                  data-action="update"
                  onClick={() => void applyUpdate(item)}
                  disabled={!item.update || updating !== null || removing !== null}
                  title={item.update ? tr("pages.content.updateTo", { version: item.update.versionLabel }) : tr("pages.content.noUpdate")}
                >
                  {updating === item.fileName ? tr("pages.content.updating") : tr("pages.content.update")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost"
                  data-action="delete"
                  onClick={() => setRemoving(item)}
                  disabled={busyRemove || updating !== null}
                >
                  <IconTrash size={14} />
                  {tr("pages.common.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={tr("pages.content.deleteTitle", { unit })}
        message={removing
          ? tr("pages.content.deleteMessage", { name: removing.name ?? removing.fileName, dir: meta.dir })
          : ""}
        confirmText={tr("pages.common.delete")}
        danger
        busy={busyRemove}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}

/** 实例内容管理：模组 / 光影包 / 资源包合进一个分段控件 + 单一面板，从实例详情抽屉里独立出来。 */
export function ContentDrawer({
  instance, open, onClose,
}: {
  instance: InstanceMeta | null;
  open: boolean;
  onClose: () => void;
}) {
  const { push } = useToast();
  // 模组列表按「其它 → Mod 管理样式」决定首行显示译名还是文件名。
  const { settings } = useApp();
  const display = settings?.modDisplayStyle ?? "title";
  const instanceId = instance?.id ?? null;

  const [mods, setMods] = useState<InstalledModInfo[] | null>(null);
  const [modsLoading, setModsLoading] = useState(false);
  const [modsError, setModsError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstalledModInfo | null>(null);
  const [busyRemove, setBusyRemove] = useState(false);
  const [modSearch, setModSearch] = useState("");
  // 三个内容分区合并成一个面板，默认看模组。
  const [contentTab, setContentTab] = useState<ContentTab>("mod");
  const tr = useT();
  const [packCounts, setPackCounts] = useState<Record<PackKind, number | null>>({ shader: null, resourcepack: null });

  // 光影 / 资源包分区各自上报已加载条数；值没变时返回同一个对象，避免多余渲染。
  const reportPackCount = useCallback((kind: PackKind, count: number | null) => {
    setPackCounts((prev) => (prev[kind] === count ? prev : { ...prev, [kind]: count }));
  }, []);

  const loadMods = useCallback(async () => {
    if (!instanceId) return;
    setModsLoading(true);
    try {
      setMods(await api.mods.installed(instanceId));
      setModsError(null);
    } catch (error: unknown) {
      setModsError(errorMessage(error));
    } finally {
      setModsLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!open || !instanceId) return;
    const from = perfNow();
    setMods(null);
    setModsError(null);
    setModSearch("");
    void loadMods().then(() => perfSince("content-drawer-open", from));
  }, [open, instanceId, loadMods]);

  // 切换分段：测「点到下一帧」的耗时；是否重新读盘由各分区自己决定
  const switchTab = useCallback((next: ContentTab) => {
    const from = perfNow();
    setContentTab(next);
    window.requestAnimationFrame(() => perfSince(`content-tab-switch-${next}`, from));
  }, []);

  const modQuery = useMemo(() => normalizeSearch(modSearch), [modSearch]);
  // 搜索只决定展示哪几行：mods 仍是全量数据，删除/刷新后按最新列表重新过滤。
  const visibleMods = useMemo(() => (mods ?? []).filter((mod) => matchSearch(mod, modQuery)), [mods, modQuery]);
  const updatableCount = useMemo(() => visibleMods.filter((item) => item.update).length, [visibleMods]);

  const checkUpdates = async () => {
    if (!instanceId) return;
    setChecking(true);
    try {
      const next = await api.mods.checkUpdates(instanceId);
      setMods(next);
      const found = next.filter((item) => item.update).length;
      push(
        tr(found > 0 ? "pages.content.checkDoneUpdatable" : "pages.content.checkDoneNoUpdate", {
          total: next.length,
          unit: tr("pages.content.modUnit"),
          found,
        }),
        "success",
      );
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async (mod: InstalledModInfo) => {
    if (!instanceId || !mod.update) return;
    setUpdating(mod.fileName);
    try {
      const result = await api.mods.update(instanceId, mod.fileName);
      push(tr("pages.content.updatedTo", { name: result.fileName }), "success");
      await loadMods();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setUpdating(null);
    }
  };

  const confirmRemove = async () => {
    if (!instanceId || !removing) return;
    setBusyRemove(true);
    try {
      await api.mods.remove(instanceId, removing.fileName);
      push(tr("pages.content.deleted", { name: removing.name ?? removing.fileName }), "success");
      setRemoving(null);
      await loadMods();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusyRemove(false);
    }
  };

  return (
    <Drawer
      open={open && instance !== null}
      title={instance?.name ?? ""}
      subtitle={instance ? tr("pages.content.subtitle", { mc: instance.mcVersion }) : undefined}
      width={760}
      onClose={onClose}
    >
      <section className="detail-section content-drawer-panel" data-content-section>
        <div className="drawer-section-head">
          <span className="field-label">{tr("pages.content.sectionTitle")}</span>
          <span className="muted-text">{tr("pages.content.sectionHint")}</span>
        </div>

        <div className="content-tabs" role="radiogroup" aria-label={tr("pages.content.tabsAria")}>
          {CONTENT_TABS.map((tab) => {
            const active = contentTab === tab.value;
            const count = tab.value === "mod" ? (mods === null ? null : mods.length) : packCounts[tab.value];
            return (
              <button
                key={tab.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`source-card content-tab ${active ? "active" : ""}`.trim()}
                data-content-tab={tab.value}
                onClick={() => switchTab(tab.value)}
              >
                <span className={`radio-dot ${active ? "on" : ""}`} aria-hidden="true" />
                <span className="source-name">
                  {count === null ? tr(tab.labelKey) : `${tr(tab.labelKey)} ${count}`}
                </span>
              </button>
            );
          })}
        </div>

        <div className="detail-content-panel" data-content-panel="mod" hidden={contentTab !== "mod"}>
          <div className="drawer-section-head">
            <span className="field-label">{tr("pages.content.modListTitle")}</span>
            <span className="muted-text" data-mods-stats>
              {mods === null
                ? tr("pages.content.modsReading")
                : modQuery
                  ? (
                    <>
                      {tr("pages.content.statTotal", { total: mods.length })}
                      <span className="detail-match-count">{tr("pages.content.statMatched", { count: visibleMods.length })}</span>
                      {tr("pages.content.statUpdatableTail", { count: updatableCount })}
                    </>
                  ) : tr("pages.content.statPlain", { total: mods.length, count: updatableCount })}
            </span>
          </div>

          <div className="detail-search-row">
            <TextInput
              type="search"
              className="detail-search-input"
              data-mod-search="mod"
              value={modSearch}
              placeholder={tr("pages.content.searchInstalled", { unit: tr("pages.content.modUnit") })}
              aria-label={tr("pages.content.searchInstalled", { unit: tr("pages.content.modUnit") })}
              onChange={(event) => setModSearch(event.target.value)}
              disabled={mods === null}
            />
          </div>

          <div className="detail-mods-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void checkUpdates()}
              disabled={checking || modsLoading || mods === null}
            >
              <IconZap size={15} />
              {checking ? tr("pages.content.checking") : tr("pages.content.checkUpdates")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void loadMods()}
              disabled={modsLoading || checking}
            >
              <IconRefresh size={15} />
              {tr("pages.common.refresh")}
            </button>
          </div>

          {modsLoading && mods === null ? <SkeletonRows count={3} /> : null}
          {modsError ? <ErrorState message={modsError} onRetry={() => void loadMods()} /> : null}

          {!modsError && mods !== null && mods.length === 0 ? (
            <EmptyState
              title={tr("pages.content.modsEmptyTitle")}
              hint={tr("pages.content.modsEmptyHint")}
            />
          ) : null}

          {!modsError && mods !== null && mods.length > 0 && visibleMods.length === 0 ? (
            <EmptyState
              title={tr("pages.content.modsNoMatchTitle")}
              hint={tr("pages.content.noMatchHint", {
                unit: tr("pages.content.modUnit"),
                query: modSearch.trim(),
              })}
              action={(
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  data-action="clear-mod-search"
                  onClick={() => setModSearch("")}
                >
                  {tr("pages.content.clearSearch")}
                </button>
              )}
            />
          ) : null}

          {!modsError && mods !== null && mods.length > 0 && visibleMods.length > 0 ? (
            <ul className="detail-mods-table">
              <li className="detail-mods-row is-head" aria-hidden="true">
                <span>{display === "filename" ? tr("pages.content.colFileName") : tr("pages.content.colName")}</span>
                <span>{tr("pages.content.colVersion")}</span>
                <span>{tr("pages.content.colSize")}</span>
                <span className="detail-mods-ops">{tr("pages.content.colOps")}</span>
              </li>
              {visibleMods.map((mod) => (
                <li
                  key={mod.fileName}
                  className={`detail-mods-row ${mod.update ? "has-update" : ""}`}
                  data-mod-file={mod.fileName}
                >
                  <div className="detail-mod-main" data-display-style={display}>
                    <span className="detail-mod-name">
                      {display === "filename" ? mod.fileName : (mod.name ?? mod.fileName)}
                    </span>
                    <span className="detail-mod-file" title={display === "filename" ? (mod.name ?? mod.fileName) : mod.fileName}>
                      {display === "filename" ? (mod.name ?? mod.fileName) : mod.fileName}
                    </span>
                    {mod.update ? (
                      <span className="badge detail-update-tag">
                        {tr("pages.content.updatableTag", { version: mod.update.versionLabel })}
                      </span>
                    ) : null}
                  </div>
                  <span className="detail-mod-version">{mod.version ?? "—"}</span>
                  <span className="detail-mod-size">{formatBytes(mod.sizeBytes)}</span>
                  <div className="detail-mods-ops">
                    <button
                      type="button"
                      className={`btn btn-sm ${mod.update ? "btn-update-on" : "btn-ghost"}`}
                      data-action="update"
                      onClick={() => void applyUpdate(mod)}
                      disabled={!mod.update || updating !== null || removing !== null}
                      title={mod.update ? tr("pages.content.updateTo", { version: mod.update.versionLabel }) : tr("pages.content.noUpdate")}
                    >
                      {updating === mod.fileName ? tr("pages.content.updating") : tr("pages.content.update")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost"
                      data-action="delete"
                      onClick={() => setRemoving(mod)}
                      disabled={busyRemove || updating !== null}
                    >
                      <IconTrash size={14} />
                      {tr("pages.common.delete")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <PackSection
          open={open}
          instanceId={instanceId}
          kind="shader"
          push={push}
          hidden={contentTab !== "shader"}
          onCount={reportPackCount}
        />
        <PackSection
          open={open}
          instanceId={instanceId}
          kind="resourcepack"
          push={push}
          hidden={contentTab !== "resourcepack"}
          onCount={reportPackCount}
        />
      </section>

      <ConfirmDialog
        open={removing !== null}
        title={tr("pages.content.deleteModTitle")}
        message={removing
          ? tr("pages.content.deleteModMessage", { name: removing.name ?? removing.fileName })
          : ""}
        confirmText={tr("pages.common.delete")}
        danger
        busy={busyRemove}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      />
    </Drawer>
  );
}
