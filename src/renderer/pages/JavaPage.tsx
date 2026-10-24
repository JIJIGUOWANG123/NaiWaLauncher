import { useMemo, useState } from "react";
import type { JavaSourceId, JavaVendorId } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { LtsTag } from "../components/Badges";
import { Segmented } from "../components/Form";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { IconCheck, IconDownload, IconJava, IconRefresh } from "../components/icons";

/** 七个下载源：auto 会先测速再挑最快的那个（Oracle JDK 因许可限制不参与 auto）。 */
const SOURCE_TABS: Array<{ value: JavaSourceId; labelKey: string }> = [
  { value: "auto", labelKey: "pages.java.sourceAuto" },
  { value: "bellsoft", labelKey: "pages.java.sourceBellsoft" },
  { value: "adoptium", labelKey: "pages.java.sourceAdoptium" },
  { value: "tuna", labelKey: "pages.java.sourceTuna" },
  { value: "zulu", labelKey: "pages.java.sourceZulu" },
  { value: "oracle", labelKey: "pages.java.sourceOracle" },
  { value: "dragonwell", labelKey: "pages.java.sourceDragonwell" },
];

const SOURCE_LABEL_KEY: Record<JavaSourceId, string> = {
  auto: "pages.java.sourceAuto",
  bellsoft: "pages.java.sourceBellsoft",
  adoptium: "pages.java.sourceAdoptium",
  tuna: "pages.java.sourceTuna",
  zulu: "pages.java.sourceZulu",
  oracle: "pages.java.sourceOracle",
  dragonwell: "pages.java.sourceDragonwell",
};

/** 已装 JDK 的来源徽标：source 缺失（老记录）显示「未知」。 */
const VENDOR_KEY: Record<JavaVendorId | "unknown", string> = {
  bellsoft: "pages.java.vendorBellsoft",
  adoptium: "pages.java.vendorAdoptium",
  tuna: "pages.java.vendorTuna",
  zulu: "pages.java.vendorZulu",
  oracle: "pages.java.vendorOracle",
  dragonwell: "pages.java.vendorDragonwell",
  system: "pages.java.vendorSystem",
  unknown: "pages.java.vendorUnknown",
};

export function JavaPage() {
  const { push } = useToast();
  const t = useT();
  const { settings, saveSettings } = useApp();
  // 下载源存在设置里：切一次全局生效，下次进页面还是它。
  const source: JavaSourceId = settings?.javaDownloadSource ?? "auto";

  const installed = useAsync(() => api.java.installed(), []);
  // 依赖里带上 source：切换下载源会自动重拉版本列表。
  const releases = useAsync(() => api.java.releases(undefined, source), [source]);
  // 只有「自动」才需要探测结果，其它源不白跑这一次。
  const probes = useAsync(
    () => (source === "auto" ? api.java.sources() : Promise.resolve([])),
    [source],
  );

  const [majorFilter, setMajorFilter] = useState("all");
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [switchingSource, setSwitchingSource] = useState(false);

  const majors = useMemo(() => {
    const set = new Set<number>((releases.data ?? []).map((item) => item.major));
    return Array.from(set).sort((a, b) => b - a);
  }, [releases.data]);

  const majorOptions = useMemo(
    () => [{ value: "all", label: t("pages.java.allVersions") }, ...majors.map((major) => ({ value: String(major), label: `Java ${major}` }))],
    [majors],
  );

  const filtered = useMemo(
    () => (releases.data ?? []).filter((item) => majorFilter === "all" || String(item.major) === majorFilter),
    [releases.data, majorFilter],
  );

  const installedSet = useMemo(
    () => new Set((installed.data ?? []).map((item) => `${item.major}-${item.version}`)),
    [installed.data],
  );

  // 「自动」模式下的探测结果：耗时最低的那个就是会被选中的源。
  const bestProbe = useMemo(() => {
    const usable = (probes.data ?? []).filter((item) => item.ok && item.latencyMs !== null);
    return [...usable].sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))[0] ?? null;
  }, [probes.data]);

  const probeText = useMemo(() => {
    const list = probes.data ?? [];
    if (list.length === 0) return "";
    const parts = list.map(
      (item) => `${item.label} ${item.latencyMs === null ? t("pages.java.probeUnavailable") : `${item.latencyMs}ms`}`,
    );
    const joined = parts.join(" · ");
    return bestProbe
      ? t("pages.java.probeChosen", { parts: joined, label: bestProbe.label })
      : t("pages.java.probeFallback", { parts: joined });
  }, [bestProbe, probes.data]);

  const changeSource = async (next: JavaSourceId) => {
    if (next === source) return;
    setSwitchingSource(true);
    try {
      await saveSettings({ javaDownloadSource: next });
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setSwitchingSource(false);
    }
  };

  const install = async (major: number, version: string) => {
    const key = `${major}-${version}`;
    setInstallingKey(key);
    try {
      // auto 由主进程按测速挑源，这里把当前选择原样传过去。
      const result = await api.java.install(major, version, source);
      push(t("pages.java.installedToast", { version: result.version }), "success");
      installed.reload();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstallingKey(null);
    }
  };

  return (
    <section className="page" data-java-page>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("pages.java.title")}</h1>
          <p className="page-sub">{t("pages.java.sub")}</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { installed.reload(); releases.reload(); probes.reload(); }}
          >
            <IconRefresh size={16} />
            {t("pages.java.refresh")}
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("pages.java.installedTitle")}</h2>
          <span className="panel-count">{t("pages.java.installedCount", { count: String(installed.data?.length ?? 0) })}</span>
        </div>

        {installed.loading ? <SkeletonRows count={2} /> : null}
        {installed.error ? <ErrorState message={installed.error} onRetry={installed.reload} /> : null}
        {!installed.loading && !installed.error && (installed.data ?? []).length === 0 ? (
          <EmptyState title={t("pages.java.noJdkTitle")} hint={t("pages.java.noJdkHint")} />
        ) : null}

        {(installed.data ?? []).length > 0 ? (
          <ul className="java-list">
            {(installed.data ?? []).map((item) => (
              <li key={`${item.major}-${item.version}-${item.path}`} className="java-row">
                <span className="java-icon"><IconJava size={18} /></span>
                <div className="java-main">
                  <div className="java-title">
                    <strong>Java {item.major}</strong>
                    <span className="java-version">{item.version}</span>
                    <span className="chip">{item.vendor}</span>
                    {/* 来源徽标：六个安装源 + system，缺失时「未知」 */}
                    <span
                      className="chip java-source-chip"
                      data-java-installed-source={item.source ?? "unknown"}
                      title={t("pages.java.sourceTitle")}
                    >
                      {t(VENDOR_KEY[item.source ?? "unknown"])}
                    </span>
                  </div>
                  <p className="java-path" title={item.path}>{item.path}</p>
                </div>
                <span className="pill pill-done"><IconCheck size={13} />{t("pages.java.ready")}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("pages.java.availableTitle")}</h2>
          <span className="panel-count">
            {source === "auto"
              ? (bestProbe
                ? t("pages.java.autoPicked", { label: bestProbe.label })
                : t("pages.java.autoPicking"))
              : t("pages.java.fromSource", { label: t(SOURCE_LABEL_KEY[source]) })}
          </span>
        </div>

        <div className="java-source-row">
          <div className="source-tabs" role="tablist" aria-label={t("pages.java.sourceAria")}>
            {SOURCE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={source === tab.value}
                className={`source-tab ${source === tab.value ? "active" : ""}`.trim()}
                data-java-source={tab.value}
                title={tab.value === "oracle" ? t("pages.java.oracleLicenseShort") : undefined}
                disabled={switchingSource}
                onClick={() => void changeSource(tab.value)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
          {source === "auto" ? (
            <p className="java-source-probe" data-java-source-probe>
              {probes.loading ? t("pages.java.probing") : (probeText || t("pages.java.noProbe"))}
            </p>
          ) : (
            <p className="java-source-probe">{t("pages.java.locked", { label: t(SOURCE_LABEL_KEY[source]) })}</p>
          )}
        </div>

        {/* Oracle JDK 许可提示：镜像只是可选项，必须让用户看到这条限制 */}
        {source === "oracle" ? (
          <p className="java-source-probe" data-java-oracle-license>
            {t("pages.java.oracleLicense")}
          </p>
        ) : null}

        <div className="filter-row">
          <Segmented value={majorFilter} options={majorOptions} onChange={setMajorFilter} />
        </div>

        {releases.loading ? <SkeletonRows count={5} /> : null}
        {releases.error ? <ErrorState message={releases.error} onRetry={releases.reload} /> : null}
        {!releases.loading && !releases.error && filtered.length === 0 ? (
          <EmptyState title={t("pages.java.noVersionsTitle")} hint={t("pages.java.noVersionsHint")} />
        ) : null}

        {filtered.length > 0 ? (
          <ul className="version-list">
            {filtered.map((release) => {
              const key = `${release.major}-${release.version}`;
              const isInstalled = installedSet.has(key);
              const isInstalling = installingKey === key;
              return (
                <li key={release.downloadUrl} className="version-row">
                  <div className="version-main">
                    <span className="version-id">Java {release.major}</span>
                    <span className="java-version">{release.version}</span>
                    {release.lts ? <LtsTag /> : null}
                    {release.sizeBytes ? <span className="version-date">{formatBytes(release.sizeBytes)}</span> : null}
                    {release.source
                      ? <span className="chip" data-java-release-source={release.source}>{t(VENDOR_KEY[release.source])}</span>
                      : null}
                  </div>
                  <div className="version-action">
                    {isInstalled ? <span className="pill pill-done">{t("pages.java.installed")}</span> : null}
                    <button
                      type="button"
                      className={`btn ${isInstalled ? "btn-ghost" : "btn-primary"} btn-sm`}
                      onClick={() => void install(release.major, release.version)}
                      disabled={installingKey !== null}
                    >
                      <IconDownload size={15} />
                      {isInstalling
                        ? t("pages.java.installing")
                        : isInstalled ? t("pages.java.reinstall") : t("pages.java.install")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
