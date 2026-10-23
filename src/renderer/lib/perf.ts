/**
 * 渲染进程启动计时。perf.ts 必须是入口（main.tsx）的第一个 import：
 * 它的模块求值时刻就是这份计时的起点。
 */
function clock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

const startedAt = clock();

/** 距离渲染进程入口开始执行已经过去的毫秒数。 */
export function perfNow(): number {
  return clock();
}

/** 从任意起点计时：完成时打一条 "perf: <stage> <ms>"。 */
export function perfSince(stage: string, from: number): number {
  const ms = Math.round(clock() - from);
  console.info(`perf: ${stage} ${ms}`);
  return ms;
}

/** 从入口算起的阶段耗时。 */
export function perfMark(stage: string): number {
  return perfSince(stage, startedAt);
}

/** 包一层 Promise 计时：成功/失败都打点，失败用 <stage>-error 区分。 */
export function perfTime<T>(stage: string, task: Promise<T>): Promise<T> {
  const from = clock();
  return task.then(
    (value) => {
      perfSince(stage, from);
      return value;
    },
    (error: unknown) => {
      perfSince(`${stage}-error`, from);
      throw error;
    },
  );
}

interface IdleHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
}

/**
 * 首帧之后再干非首屏必需的活（拉媒体列表、版本清单、实例占用统计）。
 * 页面已经加载完时 requestIdleCallback 回调立即排队，不会拖到下一个空闲窗口；
 * 没有这个 API 的环境退化成 setTimeout 0。
 */
export function afterFirstFrame(task: () => void, timeoutMs = 800): void {
  const host = globalThis as IdleHost;
  if (typeof host.requestIdleCallback === "function") {
    host.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return;
  }
  window.setTimeout(task, 0);
}
