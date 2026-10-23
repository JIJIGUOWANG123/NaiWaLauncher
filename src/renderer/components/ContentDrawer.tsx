import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledModInfo, InstanceMeta } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
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

const PACK_META: Record<PackKind, { label: string; dir: string; unit: string }> = {
  shader: { label: "光影包", dir: "shaderpacks", unit: "光影包" },
  resourcepack: { label: "资源包", dir: "resourcepacks", unit: "资源包" },
};

/** 搜索词归一化：小写并去掉所有空白，空串表示不过滤。 */
function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

/** 内容分区：模组 / 光影包 / 资源包共用一个分段控件与一个面板。 */
type ContentTab = "mod" | PackKind;

const CONTENT_TABS: Array<{ value: ContentTab; label: string }> = [
  { value: "mod", label: "模组" },
  { value: "shader", label: "光影包" },
  { value: "resourcepack", label: "资源包" },
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
    setLoading(true);
    try {
      setItems(await api.mods.installed(instanceId, kind));
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [instanceId, kind]);

  // 换实例或重新打开时先清空，否则会短暂显示上一个实例的列表；搜索词也一并清掉，免得新实例被旧关键词过滤成空。
  useEffect(() => {
    if (!open || !instanceId) return;
    setItems(null);
    setError(null);
    setSearch("");
    void load();
  }, [open, instanceId, load]);

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
      push(found > 0
        ? `检查完成：共 ${next.length} 个${meta.unit}，${found} 个可更新`
        : `检查完成：共 ${next.length} 个${meta.unit}，暂无更新`, "success");
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
      push(`已更新为 ${result.fileName}`, "success");
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
      push(`已删除 ${removing.name ?? removing.fileName}`, "success");
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
        <span className="field-label">{meta.label}</span>
        <span className="muted-text" data-pack-stats>
          {items === null
            ? `正在读取 ${meta.dir} 目录…`
            : query
              ? (
                <>
                  {`共 ${items.length} 个，`}
                  <span className="detail-match-count">{`匹配 ${visible.length} 个`}</span>
                  {`，可更新 ${updatable} 个`}
                </>
              )
              : `共 ${items.length} 个，可更新 ${updatable} 个`}
        </span>
      </div>

      <div className="detail-search-row">
        <TextInput
          type="search"
          className="detail-search-input"
          data-pack-search={kind}
          value={search}
          placeholder={`搜索已安装的${meta.unit}`}
          aria-label={`搜索已安装的${meta.unit}`}
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
          {checking ? "检查中…" : "检查更新"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-action="reload-packs"
          onClick={() => void load()}
          disabled={loading || checking}
        >
          <IconRefresh size={15} />
          刷新
        </button>
      </div>

      {loading && items === null ? <SkeletonRows count={3} /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {!error && items !== null && items.length === 0 ? (
        <EmptyState
          title={`该实例还没有安装${meta.unit}`}
          hint={`去「资源」页下载${meta.unit}，选这个实例安装后就能在这里统一管理与更新`}
        />
      ) : null}

      {!error && items !== null && items.length > 0 && visible.length === 0 ? (
        <EmptyState
          title={`没有匹配的${meta.unit}`}
          hint={`没有已安装的${meta.unit}命中「${search.trim()}」，换个关键词或清空搜索`}
          action={(
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-action="clear-pack-search"
              onClick={() => setSearch("")}
            >
              清空搜索
            </button>
          )}
        />
      ) : null}

      {!error && items !== null && items.length > 0 && visible.length > 0 ? (
        <ul className="detail-mods-table" data-pack-table={kind}>
          <li className="detail-mods-row is-head is-packs" aria-hidden="true">
            <span>内容</span>
            <span>大小</span>
            <span className="detail-mods-ops">操作</span>
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
                  <span className="badge detail-update-tag">可更新 → {item.update.versionLabel}</span>
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
                  title={item.update ? `更新到 ${item.update.versionLabel}` : "没有可用更新"}
                >
                  {updating === item.fileName ? "更新中…" : "更新"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost"
                  data-action="delete"
                  onClick={() => setRemoving(item)}
                  disabled={busyRemove || updating !== null}
                >
                  <IconTrash size={14} />
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={`删除${meta.unit}`}
        message={removing
          ? `确定删除 ${removing.name ?? removing.fileName} 吗？文件会从该实例的 ${meta.dir} 目录移除。`
          : ""}
        confirmText="删除"
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
    setMods(null);
    setModsError(null);
    setModSearch("");
    void loadMods();
  }, [open, instanceId, loadMods]);

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
      push(found > 0 ? `检查完成：共 ${next.length} 个模组，${found} 个可更新` : `检查完成：共 ${next.length} 个模组，暂无更新`, "success");
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
      push(`已更新为 ${result.fileName}`, "success");
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
      push(`已删除 ${removing.name ?? removing.fileName}`, "success");
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
      subtitle={instance ? `已安装内容 · Minecraft ${instance.mcVersion}` : undefined}
      width={760}
      onClose={onClose}
    >
      <section className="detail-section content-drawer-panel" data-content-section>
        <div className="drawer-section-head">
          <span className="field-label">内容</span>
          <span className="muted-text">模组、光影包、资源包按类型分开显示，切换类型不会重新读取目录</span>
        </div>

        <div className="content-tabs" role="radiogroup" aria-label="内容类型">
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
                onClick={() => setContentTab(tab.value)}
              >
                <span className={`radio-dot ${active ? "on" : ""}`} aria-hidden="true" />
                <span className="source-name">{count === null ? tab.label : `${tab.label} ${count}`}</span>
              </button>
            );
          })}
        </div>

        <div className="detail-content-panel" data-content-panel="mod" hidden={contentTab !== "mod"}>
          <div className="drawer-section-head">
            <span className="field-label">模组列表</span>
            <span className="muted-text" data-mods-stats>
              {mods === null
                ? "正在读取 mods 目录…"
                : modQuery
                  ? (
                    <>
                      {`共 ${mods.length} 个，`}
                      <span className="detail-match-count">{`匹配 ${visibleMods.length} 个`}</span>
                      {`，可更新 ${updatableCount} 个`}
                    </>
                  )
                  : `共 ${mods.length} 个，可更新 ${updatableCount} 个`}
            </span>
          </div>

          <div className="detail-search-row">
            <TextInput
              type="search"
              className="detail-search-input"
              data-mod-search="mod"
              value={modSearch}
              placeholder="搜索已安装的模组"
              aria-label="搜索已安装的模组"
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
              {checking ? "检查中…" : "检查更新"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void loadMods()}
              disabled={modsLoading || checking}
            >
              <IconRefresh size={15} />
              刷新
            </button>
          </div>

          {modsLoading && mods === null ? <SkeletonRows count={3} /> : null}
          {modsError ? <ErrorState message={modsError} onRetry={() => void loadMods()} /> : null}

          {!modsError && mods !== null && mods.length === 0 ? (
            <EmptyState
              title="这个实例还没有模组"
              hint="把模组装进这个实例后，这里可以统一管理与更新"
            />
          ) : null}

          {!modsError && mods !== null && mods.length > 0 && visibleMods.length === 0 ? (
            <EmptyState
              title="没有匹配的模组"
              hint={`没有已安装的模组命中「${modSearch.trim()}」，换个关键词或清空搜索`}
              action={(
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  data-action="clear-mod-search"
                  onClick={() => setModSearch("")}
                >
                  清空搜索
                </button>
              )}
            />
          ) : null}

          {!modsError && mods !== null && mods.length > 0 && visibleMods.length > 0 ? (
            <ul className="detail-mods-table">
              <li className="detail-mods-row is-head" aria-hidden="true">
                <span>{display === "filename" ? "文件名" : "名称"}</span>
                <span>版本</span>
                <span>大小</span>
                <span className="detail-mods-ops">操作</span>
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
                      <span className="badge detail-update-tag">可更新 → {mod.update.versionLabel}</span>
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
                      title={mod.update ? `更新到 ${mod.update.versionLabel}` : "没有可用更新"}
                    >
                      {updating === mod.fileName ? "更新中…" : "更新"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost"
                      data-action="delete"
                      onClick={() => setRemoving(mod)}
                      disabled={busyRemove || updating !== null}
                    >
                      <IconTrash size={14} />
                      删除
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
        title="删除模组"
        message={removing ? `确定删除 ${removing.name ?? removing.fileName} 吗？文件会从该实例的 mods 目录移除。` : ""}
        confirmText="删除"
        danger
        busy={busyRemove}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      />
    </Drawer>
  );
}
