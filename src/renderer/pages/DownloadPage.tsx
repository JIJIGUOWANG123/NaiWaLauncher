import { useEffect, useMemo, useState } from "react";
import type { Settings, TaskProgress, VersionBrief } from "../../shared/types";
import { api } from "../lib/api";
import { formatDate, formatPercent } from "../lib/format";
import { useT } from "../lib/i18n";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { VersionTypeTag } from "../components/Badges";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { IconDownload, IconRefresh, IconSearch } from "../components/icons";

type TypeFilterKey = "showRelease" | "showSnapshot" | "showLegacy";

/** 下载页 / 新建实例弹窗共用的三个版本类型勾选项，直接映射 settings 里的三个布尔。 */
const TYPE_FILTERS: Array<{ key: TypeFilterKey; labelKey: string; detailKey: string }> = [
  { key: "showRelease", labelKey: "pages.download.filterRelease", detailKey: "pages.download.detailRelease" },
  { key: "showSnapshot", labelKey: "pages.download.filterSnapshot", detailKey: "pages.download.detailSnapshot" },
  { key: "showLegacy", labelKey: "pages.download.filterLegacy", detailKey: "pages.download.detailLegacy" },
];

export function DownloadPage() {
  const { versions, versionsError, reloadVersions, instances, reloadInstances, navigate, settings } = useApp();
  const { push } = useToast();
  const t = useT();
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
    const labelKey = TYPE_FILTERS.find((item) => item.key === key)?.labelKey;
    const label = labelKey ? t(labelKey) : key;
    const patch: Partial<Settings> = key === "showRelease"
      ? { showRelease: value }
      : key === "showSnapshot"
        ? { showSnapshot: value }
        : { showLegacy: value };
    void persist(patch, t("pages.download.persistShow", { label }));
  };

  const selectAllTypes = () => {
    void persist({ showRelease: true, showSnapshot: true, showLegacy: true }, t("pages.download.persistAll"));
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
        name: t("pages.download.vanillaInstanceName", { version: version.id }),
        mcVersion: version.id,
        loader: "vanilla",
        memoryMb: 4096,
      });
      push(t("pages.download.installedToast", { version: version.id }), "success");
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
          <h1 className="page-title">{t("pages.download.title")}</h1>
          <p className="page-sub">{t("pages.download.sub")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={refreshing}>
            <IconRefresh size={16} />
            {refreshing ? t("pages.download.refreshing") : t("pages.download.refresh")}
          </button>
        </div>
      </header>

      <div className="filter-bar">
        <div className="search-wrap">
          <IconSearch size={16} className="search-icon" />
          <input
            className="input search-input"
            value={query}
            placeholder={t("pages.download.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="version-type-filter" data-version-type-filter="download">
          {TYPE_FILTERS.map((filter) => (
            <label
              key={filter.key}
              className="checkline"
              title={`${t(filter.labelKey)} (${t(filter.detailKey)})`}
            >
              <input
                type="checkbox"
                aria-label={t(filter.labelKey)}
                checked={typeChecked[filter.key]}
                onChange={(event) => persistType(filter.key, event.target.checked)}
              />
              <span>{t(filter.labelKey)}</span>
            </label>
          ))}
        </div>
        <span className="filter-count">{t("pages.download.count", { count: String(list.length) })}</span>
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
                  <span className="version-date">
                    {t("pages.download.published", { date: formatDate(version.releaseTime) })}
                  </span>
                </div>
                <div className="version-action">
                  {isInstalled ? <span className="pill pill-done">{t("pages.download.installed")}</span> : null}
                  <button
                    type="button"
                    className={`btn ${isInstalled ? "btn-ghost" : "btn-primary"} btn-sm`}
                    onClick={() => void install(version)}
                    disabled={installing !== null}
                  >
                    <IconDownload size={15} />
                    {isInstalling
                      ? t("pages.download.installing")
                      : isInstalled ? t("pages.download.reinstall") : t("pages.download.install")}
                  </button>
                </div>
                {isInstalling ? (
                  <div className="row-progress">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${Math.round((progress?.percent ?? 0) * 100)}%` }} />
                    </div>
                    <span className="row-progress-text">
                      {progress
                        ? `${progress.stage} · ${formatPercent(progress.percent)}`
                        : t("pages.download.preparing")}
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
          title={t("pages.download.noTypeTitle")}
          hint={t("pages.download.noTypeHint")}
          action={
            <button type="button" className="btn btn-primary" onClick={selectAllTypes}>
              {t("pages.download.selectAll")}
            </button>
          }
        />
      ) : versions !== null && list.length === 0 ? (
        <EmptyState
          title={t("pages.download.noMatchTitle")}
          hint={query
            ? t("pages.download.noMatchHintQuery", { query })
            : t("pages.download.noMatchHintEmpty")}
          action={
            <button type="button" className="btn btn-ghost" onClick={() => setQuery("")}>
              {t("pages.download.clearSearch")}
            </button>
          }
        />
      ) : null}

      <div className="hint-card">
        <h3 className="hint-title">{t("pages.download.hintTitle")}</h3>
        <p className="hint-text">
          {t("pages.download.hintBefore")}
          <button type="button" className="link-btn" onClick={() => navigate("settings")}>
            {t("pages.download.hintLink")}
          </button>
          {t("pages.download.hintAfter")}
        </p>
      </div>
    </section>
  );
}
