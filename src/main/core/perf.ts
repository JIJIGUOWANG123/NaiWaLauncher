import { logger } from "./logger";

const log = logger("perf");

/**
 * 启动性能计时起点：perf.ts 是 main.ts 的第一个 import，求值时机早于其余模块，
 * 因此这里的时刻≈进程开始执行启动器代码的时刻。日志格式统一为 "perf: <stage> <ms>"，
 * 启动冒烟脚本按这个前缀抓取。
 */
const startedAt = Date.now();

/** 距离启动器代码开始执行已经过去的毫秒数。 */
export function perfElapsed(): number {
  return Date.now() - startedAt;
}

/** 测一段异步流程的耗时并打点（阶段名 + 毫秒），失败也照打。 */
export async function perfSpan<T>(stage: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    log.info(`perf: ${stage} ${Date.now() - started}`);
  }
}

/** 打一条阶段耗时日志并返回同名数值，方便调用方继续用它做差值。 */
export function perfMark(stage: string): number {
  const ms = perfElapsed();
  // paths 还没初始化时 logger 只走控制台：早期阶段（模块载入/app ready）照样能看到。
  log.info(`perf: ${stage} ${ms}`);
  return ms;
}
