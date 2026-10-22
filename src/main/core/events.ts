import type { TaskKind, TaskProgress, TaskResult } from "../../shared/types";

export interface TaskHandle {
  id: string;
  kind: TaskKind;
  label: string;
  update(p: Partial<TaskProgress>): void;
  done(data?: unknown): void;
  fail(err: unknown): void;
}

type Sink = { progress(p: TaskProgress): void; done(r: TaskResult): void };

let sink: Sink = { progress: () => undefined, done: () => undefined };

/** 单任务进度上限 10 次/秒，避免 IPC 洪水拖慢渲染进程。 */
const THROTTLE_MS = 100;

let sequence = 0;

export function setEventSink(next: Sink): void {
  sink = next;
}

export function createTask(kind: TaskKind, label: string): TaskHandle {
  sequence += 1;
  const id = `task-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let state: TaskProgress = {
    taskId: id,
    kind,
    label,
    stage: "",
    percent: null,
    downloadedBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    filesDone: 0,
    filesTotal: 0,
  };

  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const push = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastEmit = Date.now();
    try {
      sink.progress({ ...state });
    } catch {
      /* 渲染进程异常不应打断任务 */
    }
  };

  const result = (ok: boolean, error?: string, data?: unknown): TaskResult => ({
    taskId: id,
    kind,
    label,
    ok,
    ...(error === undefined ? {} : { error }),
    ...(data === undefined ? {} : { data }),
  });

  return {
    id,
    kind,
    label,
    update(p: Partial<TaskProgress>): void {
      if (closed) return;
      state = { ...state, ...p, taskId: id, kind, label };
      const now = Date.now();
      if (now - lastEmit >= THROTTLE_MS) push();
      // 节流窗口内合并，用尾随定时器补发最后一帧（保留最终进度）
      else if (!timer) timer = setTimeout(push, THROTTLE_MS - (now - lastEmit));
    },
    done(data?: unknown): void {
      if (closed) return;
      closed = true;
      push();
      try {
        sink.done(result(true, undefined, data));
      } catch {
        /* 忽略 */
      }
    },
    fail(err: unknown): void {
      if (closed) return;
      closed = true;
      push();
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
      try {
        sink.done(result(false, message));
      } catch {
        /* 忽略 */
      }
    },
  };
}
