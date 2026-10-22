import { useState } from "react";
import { formatBytes, formatPercent, formatSpeed } from "../lib/format";
import { useApp } from "../lib/store";
import { useTasks } from "../lib/tasks";
import { IconChevronDown, IconPackage, IconZap } from "./icons";

export function TaskPanel() {
  const { tasks, runningCount, totalSpeed, dismiss, clearFinished } = useTasks();
  const { navigate } = useApp();
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  const finished = tasks.length - runningCount;

  return (
    <section className={`task-panel ${collapsed ? "is-collapsed" : ""}`} aria-label="任务进度">
      <header className="task-panel-head">
        <button
          type="button"
          className="task-panel-title task-panel-link"
          onClick={() => navigate("downloads")}
          aria-label="打开下载管理"
          title="打开下载管理"
          data-action="task-panel-open-downloads"
        >
          <IconPackage size={16} />
          <span>任务</span>
          {runningCount > 0 ? <span className="pill pill-live">{runningCount} 进行中</span> : null}
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
              清除已完成
            </button>
          ) : null}
          <button
            type="button"
            className={`icon-btn small ${collapsed ? "flip" : ""}`}
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "展开任务面板" : "收起任务面板"}
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
                  {task.status === "done" ? "完成" : task.status === "failed" ? "失败" : formatPercent(task.percent)}
                </span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${task.status === "done" ? 100 : Math.round((task.percent ?? 0) * 100)}%` }}
                />
              </div>
              <div className="task-meta">
                <span>{task.status === "failed" ? (task.error ?? task.stage) : task.stage || "准备中"}</span>
                <span>
                  {formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}
                  {task.status === "running" && task.bytesPerSecond > 0 ? ` · ${formatSpeed(task.bytesPerSecond)}` : ""}
                </span>
              </div>
              {task.status === "running" ? null : (
                <button type="button" className="task-dismiss" onClick={() => dismiss(task.taskId)} aria-label="移除任务">
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
