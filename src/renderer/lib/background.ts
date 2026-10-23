import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundMode, MediaList } from "../../shared/types";

/** 与 personalize.css 里 .app-bg 的 opacity transition 保持一致。 */
export const BG_FADE_MS = 320;
export const BACKGROUND_INTERVAL_MIN = 5;
export const BACKGROUND_INTERVAL_MAX = 600;

/** 轮播间隔（秒）收敛到契约区间 5–600。 */
export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(BACKGROUND_INTERVAL_MAX, Math.max(BACKGROUND_INTERVAL_MIN, Math.round(value)));
}

/** 文件名比较用 NFC 归一化：同一个韩文/带音标文件名在不同来源下可能是 NFC 或 NFD，
 *  直接用 === 会判成「还没换过来」，淡出状态就可能一直被重复置位。 */
function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  return a.normalize("NFC") === b.normalize("NFC");
}

/** 顺序轮播的次序：按文件名排序（数字按数值比较，2 排在 10 前面）。 */
export function sortBackgrounds(names: string[]): string[] {
  return names
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
}

/** 下一张：sequence 循环递增；random 随机取且不与当前那张重复。 */
function nextIndex(length: number, current: number, mode: BackgroundMode): number {
  if (length <= 1) return 0;
  if (mode === "random") {
    const pick = Math.floor(Math.random() * (length - 1));
    return pick >= current ? pick + 1 : pick;
  }
  return (current + 1) % length;
}

export interface BackgroundPlayback {
  /** 当前铺在 .app-bg 上的图片名（空串表示不使用背景）。 */
  name: string;
  /** 正在淡出/淡入，用于给 .app-bg 加 class 触发 CSS transition。 */
  fading: boolean;
  /** 参与播放的图片集合。 */
  pool: string[];
}

/**
 * 背景图播放：single 用所选图片；sequence / random 按 backgroundIntervalSec 轮播。
 * 换图时先淡出再淡入（CSS transition），改间隔即时重排定时器。
 */
export function useBackgroundPlayback(
  list: MediaList | null, selected: string, mode: BackgroundMode, intervalSec: number,
): BackgroundPlayback {
  const pool = useMemo(() => {
    if (mode === "single") return selected ? [selected] : [];
    return sortBackgrounds([...(list?.backgrounds ?? [])]);
  }, [list, selected, mode]);

  // 用 join 出的字符串做依赖，避免数组每次渲染都是新引用。
  const poolKey = pool.join("\n");
  const [index, setIndex] = useState(0);
  const [name, setName] = useState(pool[0] ?? "");
  const [fading, setFading] = useState(false);

  // 播放方式 / 背景列表 / 所选背景变化：回到第一张。
  // 只有当前这张已经不在新列表里时才换名，避免无条件清空把淡出流程重新踩一遍。
  useEffect(() => {
    setIndex(0);
    const first = pool[0] ?? "";
    setName((current) => (pool.some((item) => sameName(item, current)) ? current : first));
    setFading(false);
  }, [poolKey]);

  useEffect(() => {
    if (mode === "single" || pool.length === 0) return;
    const timer = setInterval(
      () => setIndex((prev) => nextIndex(pool.length, prev, mode)),
      clampInterval(intervalSec) * 1000,
    );
    return () => clearInterval(timer);
  }, [mode, intervalSec, pool.length]);

  // nameRef 只用于「目标是否已经生效」的判断，避免把 name 放进依赖导致反复重入。
  const nameRef = useRef(name);
  nameRef.current = name;

  // 目标变化：淡出 → 换背景 → 淡入。
  useEffect(() => {
    const target = pool[index] ?? "";
    if (!target || sameName(target, nameRef.current)) return;
    setFading(true);
    const timer = setTimeout(() => {
      nameRef.current = target;
      setName(target);
      setFading(false);
    }, BG_FADE_MS);
    return () => clearTimeout(timer);
  }, [index, pool]);

  /**
   * 看门狗：只要进入淡出状态，最多 3 倍淡出时长后一定把 fading 拉回 false。
   * 没有它会有一个致命边界——淡出后换背景的定时器被别的原因清掉时，
   * .app-bg 会永久停在 opacity:0，整个背景（图片与视频）都看不见。
   */
  useEffect(() => {
    if (!fading) return;
    const guard = setTimeout(() => setFading(false), BG_FADE_MS * 3);
    return () => clearTimeout(guard);
  }, [fading]);

  return { name, fading, pool };
}