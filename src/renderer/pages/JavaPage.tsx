import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { LtsTag } from "../components/Badges";
import { Segmented } from "../components/Form";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { IconCheck, IconDownload, IconJava, IconRefresh } from "../components/icons";

export function JavaPage() {
  const { push } = useToast();
  const installed = useAsync(() => api.java.installed(), []);
  const releases = useAsync(() => api.java.releases(), []);
  const [majorFilter, setMajorFilter] = useState("all");
  const [installingKey, setInstallingKey] = useState<string | null>(null);

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

  const install = async (major: number, version: string) => {
    const key = `${major}-${version}`;
    setInstallingKey(key);
    try {
      const result = await api.java.install(major, version);
      push(`Java ${result.version} 安装完成`, "success");
      installed.reload();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstallingKey(null);
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Java 运行时</h1>
          <p className="page-sub">不同 Minecraft 版本需要不同 JDK；启动器会优先使用已安装的匹配版本</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => { installed.reload(); releases.reload(); }}>
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
          <span className="panel-count">来自 BellSoft Liberica</span>
        </div>

        <div className="filter-row">
          <Segmented value={majorFilter} options={majorOptions} onChange={setMajorFilter} />
        </div>

        {releases.loading ? <SkeletonRows count={5} /> : null}
        {releases.error ? <ErrorState message={releases.error} onRetry={releases.reload} /> : null}
        {!releases.loading && !releases.error && filtered.length === 0 ? (
          <EmptyState title="没有可下载的版本" hint="换个主版本筛选试试，或稍后刷新。" />
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
