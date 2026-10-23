import { useState } from "react";
import { formatBytes, formatPercent, formatSpeed } from "../lib/format";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { useTasks } from "../lib/tasks";
import { IconChevronDown, IconPackage, IconZap } from "./icons";

export function TaskPanel() {
  const { tasks, runningCount, totalSpeed, dismiss, clearFinished } = useTasks();
  const { navigate } = useApp();
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  const finished = tasks.length - runningCount;

  return (
    <section className={`task-panel ${collapsed ? "is-collapsed" : ""}`} aria-label={t("pages.tasks.panelAria")}>
      <header className="task-panel-head">
        <button
          type="button"
          className="task-panel-title task-panel-link"
          onClick={() => navigate("downloads")}
          aria-label={t("pages.tasks.openDownloads")}
          title={t("pages.tasks.openDownloads")}
          data-action="task-panel-open-downloads"
        >
          <IconPackage size={16} />
          <span>{t("pages.tasks.title")}</span>
          {runningCount > 0 ? <span className="pill pill-live">{t("pages.tasks.running", { count: runningCount })}</span> : null}
          {totalSpeed > 0 ? (
            <span className="task-panel-speed">
              <IconZap size={13} />
              {formatSpeed(totalSpeed)}
            </span>
          ) : null}
        </button>
        <div className="task-panel-actions">
          {finished > 0 ? (
            <button type="button" className="link-btn" onClick={clearFinished}>
              {t("pages.tasks.clearFinished")}
            </button>
          ) : null}
          <button
            type="button"
            className={`icon-btn small ${collapsed ? "flip" : ""}`}
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? t("pages.tasks.expand") : t("pages.tasks.collapse")}
          >
            <IconChevronDown size={16} />
          </button>
        </div>
      </header>

      {collapsed ? null : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.taskId} className={`task-item task-${task.status}`}>
              <div className="task-row">
                <span className="task-label">{task.label}</span>
                <span className="task-percent">
                  {task.status === "done" ? t("pages.tasks.done") : task.status === "failed" ? t("pages.tasks.failed") : formatPercent(task.percent)}
                </span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${task.status === "done" ? 100 : Math.round((task.percent ?? 0) * 100)}%` }}
                />
              </div>
              <div className="task-meta">
                <span>{task.status === "failed" ? (task.error ?? task.stage) : task.stage || t("pages.tasks.preparing")}</span>
                <span>
                  {formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}
                  {task.status === "running" && task.bytesPerSecond > 0 ? ` · ${formatSpeed(task.bytesPerSecond)}` : ""}
                </span>
              </div>
              {task.status === "running" ? null : (
                <button type="button" className="task-dismiss" onClick={() => dismiss(task.taskId)} aria-label={t("pages.tasks.remove")}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
