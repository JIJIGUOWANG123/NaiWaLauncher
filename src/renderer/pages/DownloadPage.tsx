import { useEffect, useMemo, useState } from "react";
import type { Settings, TaskProgress, VersionBrief } from "../../shared/types";
import { api } from "../lib/api";
import { formatDate, formatPercent } from "../lib/format";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { VersionTypeTag } from "../components/Badges";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { IconDownload, IconRefresh, IconSearch } from "../components/icons";

type TypeFilterKey = "showRelease" | "showSnapshot" | "showLegacy";

/** 下载页 / 新建实例弹窗共用的三个版本类型勾选项，直接映射 settings 里的三个布尔。 */
const TYPE_FILTERS: Array<{ key: TypeFilterKey; label: string; detail: string }> = [
  { key: "showRelease", label: "正式版", detail: "release" },
  { key: "showSnapshot", label: "测试版", detail: "snapshot 快照" },
  { key: "showLegacy", label: "远古版", detail: "old_beta / old_alpha" },
];

export function DownloadPage() {
  const { versions, versionsError, reloadVersions, instances, reloadInstances, navigate, settings } = useApp();
  const { push } = useToast();
  const persist = usePersist();
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const off = api.events.onProgress((next) => {
      if (next.kind === "game" || next.kind === "libraries" || next.kind === "assets") setProgress(next);
    });
    return off;
  }, []);

  // 三个勾选直接读写 settings（showRelease / showSnapshot / showLegacy），默认全勾。
  const showRelease = settings?.showRelease ?? true;
  const showSnapshot = settings?.showSnapshot ?? true;
  const showLegacy = settings?.showLegacy ?? true;
  const typeChecked: Record<TypeFilterKey, boolean> = {
    showRelease,
    showSnapshot,
    showLegacy,
  };
  const noTypeSelected = !showRelease && !showSnapshot && !showLegacy;

  const persistType = (key: TypeFilterKey, value: boolean) => {
    const label = TYPE_FILTERS.find((item) => item.key === key)?.label ?? key;
    const patch: Partial<Settings> = key === "showRelease"
      ? { showRelease: value }
      : key === "showSnapshot"
        ? { showSnapshot: value }
        : { showLegacy: value };
    void persist(patch, `${label}显示`);
  };

  const selectAllTypes = () => {
    void persist({ showRelease: true, showSnapshot: true, showLegacy: true }, "版本类型（全部勾选）");
  };

  const list = useMemo(() => {
    const all = versions ?? [];
    const keyword = query.trim().toLowerCase();
    return all.filter((item) => {
      const visible = item.type === "release"
        ? showRelease
        : item.type === "snapshot"
          ? showSnapshot
          : showLegacy;
      if (!visible) return false;
      if (keyword.length === 0) return true;
      return item.id.toLowerCase().includes(keyword);
    });
  }, [versions, query, showRelease, showSnapshot, showLegacy]);

  const installedVersions = useMemo(
    () => new Set(instances.map((item) => item.versionId)),
    [instances],
  );

  const refresh = async () => {
    setRefreshing(true);
    await reloadVersions(true);
    setRefreshing(false);
  };

  const install = async (version: VersionBrief) => {
    setInstalling(version.id);
    setProgress(null);
    try {
      await api.instances.create({
        name: `${version.id} 原版`,
        mcVersion: version.id,
        loader: "vanilla",
        memoryMb: 4096,
      });
      push(`Minecraft ${version.id} 安装完成，已创建实例`, "success");
      await reloadInstances();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstalling(null);
      setProgress(null);
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">游戏</h1>
          <p className="page-sub">选择版本安装为纯原版实例；需要模组支持请到「实例 → 新建」挑选加载器</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={refreshing}>
            <IconRefresh size={16} />
            {refreshing ? "刷新中…" : "刷新清单"}
          </button>
        </div>
      </header>

      <div className="filter-bar">
        <div className="search-wrap">
          <IconSearch size={16} className="search-icon" />
          <input
            className="input search-input"
            value={query}
            placeholder="搜索版本号，例如 1.21"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="version-type-filter" data-version-type-filter="download">
          {TYPE_FILTERS.map((filter) => (
            <label key={filter.key} className="checkline" title={`${filter.label}（${filter.detail}）`}>
              <input
                type="checkbox"
                aria-label={filter.label}
                checked={typeChecked[filter.key]}
                onChange={(event) => persistType(filter.key, event.target.checked)}
              />
              <span>{filter.label}</span>
            </label>
          ))}
        </div>
        <span className="filter-count">{list.length} 个版本</span>
      </div>

      {versions === null && versionsError === null ? <SkeletonRows count={6} /> : null}
      {versionsError ? <ErrorState message={versionsError} onRetry={() => void reloadVersions(false)} /> : null}

      {list.length > 0 ? (
        <ul className="version-list">
          {list.map((version) => {
            const isInstalled = installedVersions.has(version.id);
            const isInstalling = installing === version.id;
            return (
              <li key={version.id} className={`version-row ${isInstalling ? "is-installing" : ""}`}>
                <div className="version-main">
                  <span className="version-id">{version.id}</span>
                  <VersionTypeTag type={version.type} />
                  <span className="version-date">发布于 {formatDate(version.releaseTime)}</span>
                </div>
                <div className="version-action">
                  {isInstalled ? <span className="pill pill-done">已安装</span> : null}
                  <button
                    type="button"
                    className={`btn ${isInstalled ? "btn-ghost" : "btn-primary"} btn-sm`}
                    onClick={() => void install(version)}
                    disabled={installing !== null}
                  >
                    <IconDownload size={15} />
                    {isInstalling ? "安装中…" : isInstalled ? "重新安装" : "安装"}
                  </button>
                </div>
                {isInstalling ? (
                  <div className="row-progress">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${Math.round((progress?.percent ?? 0) * 100)}%` }} />
                    </div>
                    <span className="row-progress-text">
                      {progress ? `${progress.stage} · ${formatPercent(progress.percent)}` : "准备下载…"}
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {versions !== null && noTypeSelected ? (
        <EmptyState
          title="未选择任何版本类型"
          hint="正式版、测试版、远古版都没有勾选，版本列表为空。"
          action={
            <button type="button" className="btn btn-primary" onClick={selectAllTypes}>
              全部勾选
            </button>
          }
        />
      ) : versions !== null && list.length === 0 ? (
        <EmptyState
          title="没有匹配的版本"
          hint={query ? `没有版本名包含「${query}」，换个关键词试试。` : "清单为空，试试刷新版本清单。"}
          action={
            <button type="button" className="btn btn-ghost" onClick={() => setQuery("")}>
              清空搜索
            </button>
          }
        />
      ) : null}

      <div className="hint-card">
        <h3 className="hint-title">安装过程会做什么？</h3>
        <p className="hint-text">
          自动下载游戏本体 jar、libraries 依赖与 assets 资源文件，进度显示在右下角任务面板。安装源可在
          <button type="button" className="link-btn" onClick={() => navigate("settings")}>设置 → 下载源</button>
          切换为 BMCLAPI 镜像。
        </p>
      </div>
    </section>
  );
}
