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
 *
 * poolOverride：外部播放池（例如壁纸引擎的壁纸文件绝对路径）。
 * 传了非空数组就用它做 sequence/random 的候选，顺序按调用方给的顺序（壁纸列表已按标题排序）；
 * 不传或传空数组时行为与以前完全一致（用本地背景目录里的文件）。
 */
/** 本次进程里已经做过「启动随机」的来源：切页面/重渲染/切回来都不再重随机。 */
const startupRandomDone = new Set<string>();

export function useBackgroundPlayback(
  list: MediaList | null,
  selected: string,
  mode: BackgroundMode,
  intervalSec: number,
  poolOverride?: string[],
  /** 传了就是「本次启动随机一张」，取值是来源标识（local / api / wallpaperEngine）。 */
  startupRandomKey?: string,
): BackgroundPlayback {
  // 用 join 出来的键做依赖：调用方即使每次传新数组也不会把 pool 反复重算。
  const overrideKey = (poolOverride ?? []).filter(Boolean).join("\n");
  // 来源的完整候选集（不受 single 影响）：「启动随机」要从这里抽，而不是从单张池里抽。
  const sourcePool = useMemo(() => {
    if (overrideKey) return overrideKey.split("\n");
    return sortBackgrounds([...(list?.backgrounds ?? [])]);
  }, [list, overrideKey]);
  const sourceKey = sourcePool.join("\n");

  // 本次启动随机选中的那张（null = 没开或还没抽到）
  const [startupPick, setStartupPick] = useState<string | null>(null);
  useEffect(() => {
    if (!startupRandomKey || sourcePool.length === 0) return;
    if (startupRandomDone.has(startupRandomKey)) return;
    startupRandomDone.add(startupRandomKey);
    setStartupPick(sourcePool[Math.floor(Math.random() * sourcePool.length)] ?? null);
  }, [startupRandomKey, sourceKey]);

  const pool = useMemo(() => {
    if (mode === "single") {
      // single：启动随机选中的那张优先，否则就是用户在设置里选的那张
      const single = startupPick ?? selected;
      return single ? [single] : [];
    }
    return sourcePool;
  }, [selected, mode, startupPick, sourcePool]);

  // 用 join 出的字符串做依赖，避免数组每次渲染都是新引用。
  const poolKey = pool.join("\n");
  const [index, setIndex] = useState(0);
  const [name, setName] = useState(pool[0] ?? "");
  const [fading, setFading] = useState(false);
  // nameRef 只用于「目标是否已经生效」的判断，避免把 name 放进依赖导致反复重入。
  const nameRef = useRef(name);
  nameRef.current = name;

  // 播放方式 / 背景列表 / 所选背景变化：
  // · 当前这张还在新池子里就留在它上面（顺序轮播从它继续），否则从池头开始 ——
  //   这样壁纸引擎池晚到、或用户手改过 backgroundImage 时不会出现「空白背景」。
  useEffect(() => {
    const at = pool.findIndex((item) => sameName(item, nameRef.current));
    setIndex(at >= 0 ? at : 0);
    const first = pool[0] ?? "";
    setName((current) => (pool.some((item) => sameName(item, current)) ? current : first));
    setFading(false);
  }, [poolKey]);

  // 「启动随机」抽到之后立刻生效：single 直接换成它；sequence/random 把它设为当前并把 index 对齐，
  // 之后照常从这个位置往下轮播。
  useEffect(() => {
    if (!startupPick) return;
    if (!pool.some((item) => sameName(item, startupPick))) return;
    setIndex(Math.max(0, pool.findIndex((item) => sameName(item, startupPick))));
    setName(startupPick);
    setFading(false);
    // 只在抽到新的一张时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupPick]);

  // 用户手动换了背景（settings.backgroundImage 变了）就不再让启动随机的那张压着它
  const selectedRef = useRef(selected);
  useEffect(() => {
    if (selectedRef.current === selected) return;
    selectedRef.current = selected;
    setStartupPick(null);
  }, [selected]);

  useEffect(() => {
    if (mode === "single" || pool.length === 0) return;
    const timer = setInterval(
      () => setIndex((prev) => nextIndex(pool.length, prev, mode)),
      clampInterval(intervalSec) * 1000,
    );
    return () => clearInterval(timer);
  }, [mode, intervalSec, pool.length]);

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