import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TaskProgress } from "../../shared/types";
import { api } from "./api";

export interface TaskEntry extends TaskProgress {
  status: "running" | "done" | "failed";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface TaskContextValue {
  tasks: TaskEntry[];
  runningCount: number;
  totalSpeed: number;
  dismiss(taskId: string): void;
  clearFinished(): void;
}

const TaskContext = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, TaskEntry>>({});

  useEffect(() => {
    const offProgress = api.events.onProgress((progress) => {
      setMap((prev) => {
        const existing = prev[progress.taskId];
        const entry: TaskEntry = {
          ...progress,
          status: "running",
          startedAt: existing?.startedAt ?? Date.now(),
          error: undefined,
          finishedAt: undefined,
        };
        return { ...prev, [progress.taskId]: entry };
      });
    });
    const offDone = api.events.onTaskDone((result) => {
      setMap((prev) => {
        const existing = prev[result.taskId];
        const base: TaskEntry = existing ?? {
          taskId: result.taskId,
          kind: result.kind,
          label: result.label,
          stage: "",
          percent: result.ok ? 1 : null,
          downloadedBytes: 0,
          totalBytes: 0,
          bytesPerSecond: 0,
          filesDone: 0,
          filesTotal: 0,
          status: result.ok ? "done" : "failed",
          startedAt: Date.now(),
        };
        return {
          ...prev,
          [result.taskId]: {
            ...base,
            status: result.ok ? "done" : "failed",
            error: result.error,
            finishedAt: Date.now(),
            percent: result.ok ? 1 : base.percent,
          },
        };
      });
    });
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  const dismiss = useCallback((taskId: string) => {
    setMap((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  const clearFinished = useCallback(() => {
    setMap((prev) => {
      const next: Record<string, TaskEntry> = {};
      Object.values(prev).forEach((entry) => {
        if (entry.status === "running") next[entry.taskId] = entry;
      });
      return next;
    });
  }, []);

  const tasks = useMemo(() => {
    const list = Object.values(map);
    list.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt - a.startedAt;
    });
    return list;
  }, [map]);

  const runningCount = tasks.filter((task) => task.status === "running").length;
  const totalSpeed = tasks.filter((t) => t.status === "running").reduce((sum, t) => sum + t.bytesPerSecond, 0);

  const value = useMemo<TaskContextValue>(
    () => ({ tasks, runningCount, totalSpeed, dismiss, clearFinished }),
    [tasks, runningCount, totalSpeed, dismiss, clearFinished],
  );

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTasks(): TaskContextValue {
  const context = useContext(TaskContext);
  if (!context) throw new Error("useTasks 必须在 TaskProvider 内使用");
  return context;
}
