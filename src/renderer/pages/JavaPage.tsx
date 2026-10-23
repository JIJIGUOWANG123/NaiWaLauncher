import { useMemo, useState } from "react";
import type { JavaSourceId, JavaVendorId } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { LtsTag } from "../components/Badges";
import { Segmented } from "../components/Form";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { IconCheck, IconDownload, IconJava, IconRefresh } from "../components/icons";

/** 四个下载源：auto 会先测速再挑最快的那个。 */
const SOURCE_TABS: Array<{ value: JavaSourceId; label: string }> = [
  { value: "auto", label: "自动（测速最快）" },
  { value: "bellsoft", label: "BellSoft Liberica" },
  { value: "adoptium", label: "Adoptium (Temurin)" },
  { value: "tuna", label: "清华 TUNA 镜像" },
];

const SOURCE_LABEL: Record<JavaSourceId, string> = {
  auto: "自动（测速最快）",
  bellsoft: "BellSoft Liberica",
  adoptium: "Adoptium (Temurin)",
  tuna: "清华 TUNA 镜像",
};

/** 已装 JDK 的来源徽标：source 缺失（老记录）显示「未知」。 */
const VENDOR_LABEL: Record<JavaVendorId | "unknown", string> = {
  bellsoft: "BellSoft",
  adoptium: "Adoptium",
  tuna: "清华 TUNA",
  system: "系统",
  unknown: "未知",
};

export function JavaPage() {
  const { push } = useToast();
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
    () => [{ value: "all", label: "全部" }, ...majors.map((major) => ({ value: String(major), label: `Java ${major}` }))],
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
    const parts = list.map((item) => `${item.label} ${item.latencyMs === null ? "不可用" : `${item.latencyMs}ms`}`);
    return bestProbe
      ? `${parts.join(" · ")} → 选 ${bestProbe.label}`
      : `${parts.join(" · ")} → 都不可用，回退 BellSoft`;
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
      push(`Java ${result.version} 安装完成`, "success");
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
          <h1 className="page-title">Java 运行时</h1>
          <p className="page-sub">不同 Minecraft 版本需要不同 JDK；启动器会优先使用已安装的匹配版本</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { installed.reload(); releases.reload(); probes.reload(); }}
          >
            <IconRefresh size={16} />
            刷新
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">已安装</h2>
          <span className="panel-count">{installed.data?.length ?? 0} 个</span>
        </div>

        {installed.loading ? <SkeletonRows count={2} /> : null}
        {installed.error ? <ErrorState message={installed.error} onRetry={installed.reload} /> : null}
        {!installed.loading && !installed.error && (installed.data ?? []).length === 0 ? (
          <EmptyState title="还没有安装任何 JDK" hint="从下方列表挑一个 LTS 版本安装，或让启动器在启动时自动下载。" />
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
                    {/* 来源徽标：bellsoft / adoptium / tuna / system，缺失时「未知」 */}
                    <span
                      className="chip java-source-chip"
                      data-java-installed-source={item.source ?? "unknown"}
                      title="这个 JDK 来自哪个下载源"
                    >
                      {VENDOR_LABEL[item.source ?? "unknown"]}
                    </span>
                  </div>
                  <p className="java-path" title={item.path}>{item.path}</p>
                </div>
                <span className="pill pill-done"><IconCheck size={13} />可用</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">可下载版本</h2>
          <span className="panel-count">
            {source === "auto"
              ? (bestProbe ? `自动测速 · 当前 ${bestProbe.label}` : "自动测速挑选中")
              : `来自 ${SOURCE_LABEL[source]}`}
          </span>
        </div>

        <div className="java-source-row">
          <div className="source-tabs" role="tablist" aria-label="JDK 下载源">
            {SOURCE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={source === tab.value}
                className={`source-tab ${source === tab.value ? "active" : ""}`.trim()}
                data-java-source={tab.value}
                disabled={switchingSource}
                onClick={() => void changeSource(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {source === "auto" ? (
            <p className="java-source-probe" data-java-source-probe>
              {probes.loading ? "正在测速三个下载源…" : (probeText || "没有拿到探测结果")}
            </p>
          ) : (
            <p className="java-source-probe">已锁定 {SOURCE_LABEL[source]}；切回「自动」会重新测速。</p>
          )}
        </div>

        <div className="filter-row">
          <Segmented value={majorFilter} options={majorOptions} onChange={setMajorFilter} />
        </div>

        {releases.loading ? <SkeletonRows count={5} /> : null}
        {releases.error ? <ErrorState message={releases.error} onRetry={releases.reload} /> : null}
        {!releases.loading && !releases.error && filtered.length === 0 ? (
          <EmptyState title="没有可下载的版本" hint="换个主版本筛选试试，或切一个下载源再刷新。" />
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
                      ? <span className="chip" data-java-release-source={release.source}>{VENDOR_LABEL[release.source]}</span>
                      : null}
                  </div>
                  <div className="version-action">
                    {isInstalled ? <span className="pill pill-done">已安装</span> : null}
                    <button
                      type="button"
                      className={`btn ${isInstalled ? "btn-ghost" : "btn-primary"} btn-sm`}
                      onClick={() => void install(release.major, release.version)}
                      disabled={installingKey !== null}
                    >
                      <IconDownload size={15} />
                      {isInstalling ? "安装中…" : isInstalled ? "重新安装" : "安装"}
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
