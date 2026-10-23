import { useCallback, useEffect, useMemo, useState } from "react";
import type { DownloadJob } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes, formatDateTime, formatSpeed } from "../lib/format";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Drawer } from "../components/Drawer";
import { ErrorState, SkeletonRows } from "../components/State";
import { IconDownload, IconRefresh, IconTrash } from "../components/icons";

const STATUS_META: Record<DownloadJob["status"], { labelKey: string; cls: string }> = {
  running: { labelKey: "pages.downloads.statusRunning", cls: "dl-status-running" },
  paused: { labelKey: "pages.downloads.statusPaused", cls: "dl-status-paused" },
  interrupted: { labelKey: "pages.downloads.statusInterrupted", cls: "dl-status-interrupted" },
  cancelled: { labelKey: "pages.downloads.statusCancelled", cls: "dl-status-cancelled" },
  done: { labelKey: "pages.downloads.statusDone", cls: "dl-status-done" },
  failed: { labelKey: "pages.downloads.statusFailed", cls: "dl-status-failed" },
};

const KIND_KEY: Record<DownloadJob["kind"], string> = {
  version: "pages.downloads.kindVersion",
  loader: "pages.downloads.kindLoader",
  java: "pages.downloads.kindJava",
  content: "pages.downloads.kindContent",
};

/** 进度条宽度与百分比共用的夹取，避免脏数据把条撑破。 */
function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

/** 只认「有意义的正数」：缺字段 / 0 / NaN / 负数一律返回 null，界面据此不渲染。 */
function positiveBytes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function DownloadsPage() {
  const { push } = useToast();
  const t = useT();
  const [jobs, setJobs] = useState<DownloadJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await api.downloads.list());
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // 主进程在任务状态变化时推全量列表；卸载时取消订阅。
    return api.downloads.onChanged((next) => {
      setJobs(next);
      setError(null);
    });
  }, [load]);

  const list = useMemo(
    () => [...(jobs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [jobs],
  );

  const act = async (action: "resume" | "cancel" | "remove" | "clearFinished", job?: DownloadJob) => {
    setBusy(job ? `${action}:${job.id}` : action);
    try {
      if (action === "resume" && job) {
        await api.downloads.resume(job.id);
        push(t("pages.downloads.resumed", { title: job.title }), "success");
      } else if (action === "cancel" && job) {
        // 主进程正在实现真正的传输中断；UI 只负责发请求并如实显示「已终止」。
        await api.downloads.cancel(job.id);
        push(t("pages.downloads.cancelled", { title: job.title }), "success");
      } else if (action === "remove" && job) {
        await api.downloads.remove(job.id);
        push(t("pages.downloads.removed", { title: job.title }), "success");
      } else {
        await api.downloads.clearFinished();
        push(t("pages.downloads.cleared"), "success");
      }
      // 主进程会推 onChanged；这里再拉一次，保证没有推送的实现也不会停在旧列表。
      await load();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const renderActions = (job: DownloadJob) => {
    const canResume = job.status === "interrupted" || job.status === "cancelled" || job.status === "failed";
    const canCancel = job.status === "running";
    return (
      <div className="dl-actions">
        {canResume ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-action="resume"
            data-dl-id={job.id}
            disabled={busy !== null}
            onClick={() => void act("resume", job)}
          >
            <IconDownload size={14} />
            {t("pages.downloads.resume")}
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-action="cancel"
            data-dl-id={job.id}
            title={t("pages.downloads.cancelTitle")}
            disabled={busy !== null}
            onClick={() => void act("cancel", job)}
          >
            {t("pages.downloads.cancel")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm dl-remove"
          data-action="remove"
          data-dl-id={job.id}
          disabled={busy !== null}
          onClick={() => void act("remove", job)}
        >
          <IconTrash size={14} />
          {t("pages.downloads.remove")}
        </button>
      </div>
    );
  };

  const renderDetail = (job: DownloadJob) => (
    <div className="dl-detail-view" data-dl-detail={job.id}>
      <dl className="dl-facts">
        <div className="dl-fact">
          <dt>{t("pages.downloads.status")}</dt>
          <dd>
            <span className={`badge dl-status ${STATUS_META[job.status].cls}`}>
              {t(STATUS_META[job.status].labelKey)}
            </span>
          </dd>
        </div>
        <div className="dl-fact">
          <dt>{t("pages.downloads.progress")}</dt>
          <dd>{clampProgress(job.progress)}%</dd>
        </div>
        {positiveBytes(job.bytesPerSecond) !== null && job.status === "running" ? (
          <div className="dl-fact">
            <dt>{t("pages.downloads.speed")}</dt>
            <dd data-dl-speed>{formatSpeed(positiveBytes(job.bytesPerSecond) ?? 0)}</dd>
          </div>
        ) : null}
        {positiveBytes(job.totalBytes) !== null ? (
          <div className="dl-fact">
            <dt>{t("pages.downloads.size")}</dt>
            <dd data-dl-bytes>
              {formatBytes(Math.min(positiveBytes(job.downloadedBytes) ?? 0, positiveBytes(job.totalBytes) ?? 0))}
              {" / "}
              {formatBytes(positiveBytes(job.totalBytes) ?? 0)}
            </dd>
          </div>
        ) : null}
        <div className="dl-fact">
          <dt>{t("pages.downloads.kind")}</dt>
          <dd>{t(KIND_KEY[job.kind])}</dd>
        </div>
        <div className="dl-fact">
          <dt>{t("pages.downloads.createdAt")}</dt>
          <dd>{formatDateTime(job.createdAt)}</dd>
        </div>
        <div className="dl-fact">
          <dt>{t("pages.downloads.updatedAt")}</dt>
          <dd>{formatDateTime(job.updatedAt)}</dd>
        </div>
        <div className="dl-fact">
          <dt>{t("pages.downloads.taskId")}</dt>
          <dd className="dl-mono">{job.id}</dd>
        </div>
      </dl>

      <section className="dl-message-block">
        <h3 className="hint-title">{t("pages.downloads.detailTitle")}</h3>
        <p className="hint-text dl-message" data-dl-message>
          {job.message ? job.message : t("pages.downloads.detailEmpty")}
        </p>
      </section>
    </div>
  );

  const detail = list.find((job) => job.id === detailId) ?? null;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("pages.downloads.title")}</h1>
          <p className="page-sub">{t("pages.downloads.sub")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            <IconRefresh size={16} />
            {t("pages.downloads.refresh")}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-action="clear-finished"
            disabled={busy !== null}
            onClick={() => void act("clearFinished")}
          >
            {t("pages.downloads.clearFinished")}
          </button>
        </div>
      </header>

      {jobs === null && error === null ? <SkeletonRows count={4} /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {list.length > 0 ? (
        <ul className="dl-list" data-dl-list>
          {list.map((job) => {
            const meta = STATUS_META[job.status];
            const percent = clampProgress(job.progress);
            // 缺字段时保持 null：不显示，而不是显示 0 B / NaN
            const speed = job.status === "running" ? positiveBytes(job.bytesPerSecond) : null;
            const totalBytes = positiveBytes(job.totalBytes);
            const doneBytes = totalBytes === null ? null : Math.min(positiveBytes(job.downloadedBytes) ?? 0, totalBytes);
            return (
              <li key={job.id} className={`dl-row dl-row-${job.status}`} data-dl-row={job.id}>
                <div className="dl-main">
                  <div className="dl-head">
                    <button
                      type="button"
                      className="dl-title"
                      data-action="open-detail"
                      data-dl-id={job.id}
                      title={t("pages.downloads.viewDetail")}
                      onClick={() => setDetailId(job.id)}
                    >
                      {job.title}
                    </button>
                    <span className={`badge dl-status ${meta.cls}`} data-dl-status={job.status}>
                      {t(meta.labelKey)}
                    </span>
                  </div>
                  <p className="dl-detail">{job.detail}</p>
                  <div className="dl-progress">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="dl-percent">{percent}%</span>
                  </div>
                  <div className="dl-meta">
                    <span>{t(KIND_KEY[job.kind])}</span>
                    {speed !== null ? (
                      <span className="dl-speed" data-dl-speed>{formatSpeed(speed)}</span>
                    ) : null}
                    {totalBytes !== null ? (
                      <span className="dl-bytes" data-dl-bytes>
                        {formatBytes(doneBytes ?? 0)} / {formatBytes(totalBytes)}
                      </span>
                    ) : null}
                    <span className="dl-time">
                      {t("pages.downloads.updatedAtShort", { time: formatDateTime(job.updatedAt) })}
                    </span>
                  </div>
                  {job.status === "failed" && job.message ? (
                    <p className="dl-error" data-dl-error role="alert">
                      {t("pages.downloads.failedReason", { error: job.message })}
                    </p>
                  ) : null}
                </div>
                {renderActions(job)}
              </li>
            );
          })}
        </ul>
      ) : null}

      {jobs !== null && list.length === 0 ? (
        <div className="state state-empty" data-dl-empty>
          <div className="state-body">
            <p className="state-hint">{t("pages.downloads.empty")}</p>
          </div>
        </div>
      ) : null}

      {/* 自绘标题栏占 40px，抽屉从这里往下铺，标题与关闭按钮才不会被压住 */}
      <div className="dl-drawer-scope">
        <Drawer
          open={detail !== null}
          title={detail?.title ?? t("pages.downloads.drawerTitle")}
          subtitle={detail?.detail}
          onClose={() => setDetailId(null)}
          footer={detail ? renderActions(detail) : null}
        >
          {detail ? renderDetail(detail) : null}
        </Drawer>
      </div>
    </section>
  );
}
