import { useCallback, useEffect, useMemo, useState } from "react";
import type { DownloadJob } from "../../shared/types";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Drawer } from "../components/Drawer";
import { ErrorState, SkeletonRows } from "../components/State";
import { IconDownload, IconRefresh, IconTrash } from "../components/icons";

const STATUS_META: Record<DownloadJob["status"], { label: string; cls: string }> = {
  running: { label: "进行中", cls: "dl-status-running" },
  paused: { label: "已暂停", cls: "dl-status-paused" },
  interrupted: { label: "已中断", cls: "dl-status-interrupted" },
  cancelled: { label: "已终止", cls: "dl-status-cancelled" },
  done: { label: "已完成", cls: "dl-status-done" },
  failed: { label: "失败", cls: "dl-status-failed" },
};

const KIND_LABEL: Record<DownloadJob["kind"], string> = {
  version: "安装游戏版本",
  loader: "安装加载器",
  java: "安装 Java",
  content: "下载模组内容",
};

/** 进度条宽度与百分比共用的夹取，避免脏数据把条撑破。 */
function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function DownloadsPage() {
  const { push } = useToast();
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
        push(`已继续「${job.title}」`, "success");
      } else if (action === "cancel" && job) {
        // 主进程正在实现真正的传输中断；UI 只负责发请求并如实显示「已终止」。
        await api.downloads.cancel(job.id);
        push(`已终止「${job.title}」`, "success");
      } else if (action === "remove" && job) {
        await api.downloads.remove(job.id);
        push(`已移除「${job.title}」`, "success");
      } else {
        await api.downloads.clearFinished();
        push("已清空完成记录", "success");
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
            继续
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-action="cancel"
            data-dl-id={job.id}
            title="终止这次下载（进度保留，可再继续）"
            disabled={busy !== null}
            onClick={() => void act("cancel", job)}
          >
            终止
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
          移除
        </button>
      </div>
    );
  };

  const renderDetail = (job: DownloadJob) => (
    <div className="dl-detail-view" data-dl-detail={job.id}>
      <dl className="dl-facts">
        <div className="dl-fact">
          <dt>状态</dt>
          <dd>
            <span className={`badge dl-status ${STATUS_META[job.status].cls}`}>{STATUS_META[job.status].label}</span>
          </dd>
        </div>
        <div className="dl-fact">
          <dt>进度</dt>
          <dd>{clampProgress(job.progress)}%</dd>
        </div>
        <div className="dl-fact">
          <dt>类型</dt>
          <dd>{KIND_LABEL[job.kind]}</dd>
        </div>
        <div className="dl-fact">
          <dt>创建时间</dt>
          <dd>{formatDateTime(job.createdAt)}</dd>
        </div>
        <div className="dl-fact">
          <dt>最近更新</dt>
          <dd>{formatDateTime(job.updatedAt)}</dd>
        </div>
        <div className="dl-fact">
          <dt>任务 id</dt>
          <dd className="dl-mono">{job.id}</dd>
        </div>
      </dl>

      <section className="dl-message-block">
        <h3 className="hint-title">详细信息</h3>
        <p className="hint-text dl-message" data-dl-message>
          {job.message ? job.message : "这次任务没有留下额外信息。"}
        </p>
      </section>
    </div>
  );

  const detail = list.find((job) => job.id === detailId) ?? null;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">管理</h1>
          <p className="page-sub">下载游戏、安装加载器与模组的记录都在这里；中途关掉启动器也能接着下。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            <IconRefresh size={16} />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-action="clear-finished"
            disabled={busy !== null}
            onClick={() => void act("clearFinished")}
          >
            清空已完成
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
            return (
              <li key={job.id} className={`dl-row dl-row-${job.status}`} data-dl-row={job.id}>
                <div className="dl-main">
                  <div className="dl-head">
                    <button
                      type="button"
                      className="dl-title"
                      data-action="open-detail"
                      data-dl-id={job.id}
                      title="查看下载详情"
                      onClick={() => setDetailId(job.id)}
                    >
                      {job.title}
                    </button>
                    <span className={`badge dl-status ${meta.cls}`} data-dl-status={job.status}>{meta.label}</span>
                  </div>
                  <p className="dl-detail">{job.detail}</p>
                  <div className="dl-progress">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="dl-percent">{percent}%</span>
                  </div>
                  <div className="dl-meta">
                    <span>{KIND_LABEL[job.kind]}</span>
                    <span className="dl-time">更新于 {formatDateTime(job.updatedAt)}</span>
                  </div>
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
            <p className="state-hint">还没有下载记录。下载游戏或安装模组时会自动记录，中途关闭也能在这里继续。</p>
          </div>
        </div>
      ) : null}

      {/* 自绘标题栏占 40px，抽屉从这里往下铺，标题与关闭按钮才不会被压住 */}
      <div className="dl-drawer-scope">
        <Drawer
          open={detail !== null}
          title={detail?.title ?? "下载详情"}
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
