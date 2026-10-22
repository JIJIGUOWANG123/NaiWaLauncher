import type { LogLine, TaskProgress, TaskResult } from "../../shared/types";

type ProgressListener = (progress: TaskProgress) => void;
type DoneListener = (result: TaskResult) => void;
type LogListener = (line: LogLine) => void;

/** mock 任务的简易事件总线，与 Electron 下的主进程事件同名同序。 */
export const mockBus = {
  progress: new Set<ProgressListener>(),
  done: new Set<DoneListener>(),
  log: new Set<LogListener>(),
};

export function emitProgress(progress: TaskProgress): void {
  mockBus.progress.forEach((listener) => listener(progress));
}

export function emitDone(result: TaskResult): void {
  mockBus.done.forEach((listener) => listener(result));
}
