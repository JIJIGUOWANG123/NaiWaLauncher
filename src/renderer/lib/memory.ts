/** 物理内存与堆用量读取：Electron 渲染进程里 performance.memory 不一定可用，缺失时界面显示「—」。 */

export interface HeapUsage {
  used: number | null;
  limit: number | null;
}

/** navigator.deviceMemory 是分桶值（0.25/0.5/1/2/4/8…），缺失时按 8 GB 估算。 */
export function deviceMemoryGb(): number {
  const raw = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(128, raw) : 8;
}

/** 自定义滑杆上限：物理内存的一半，取整到 512 MB 并夹在 2048–16384 MB。 */
export function memoryUpperMb(): number {
  const half = (deviceMemoryGb() * 1024) / 2;
  return Math.min(16384, Math.max(2048, Math.round(half / 512) * 512));
}

/** 自动配置的展示值：固定 4 GB，卡片文案里说明是按机器内存推荐。 */
export const RECOMMENDED_MEMORY_MB = 4096;

export function readHeap(): HeapUsage {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.jsHeapSizeLimit) || memory.jsHeapSizeLimit <= 0) {
    return { used: null, limit: null };
  }
  return { used: memory.usedJSHeapSize, limit: memory.jsHeapSizeLimit };
}
