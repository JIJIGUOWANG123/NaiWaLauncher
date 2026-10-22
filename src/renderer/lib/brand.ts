import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";

/** 品牌文案长度上限，与 core/settings.ts 里的裁剪保持一致。 */
export const BRAND_TITLE_MAX = 24;
export const BRAND_SUBTITLE_MAX = 32;

/** 留空时使用的内置文案。 */
export const DEFAULT_BRAND = { title: "NaiWa", subtitle: "奶娃启动器" } as const;

export interface BrandText {
  title: string;
  subtitle: string;
}

/**
 * 个性化页输入时的临时覆盖：不等落盘，侧边栏立刻跟着变。
 * null = 没有草稿，直接读已保存的 settings。
 */
let preview: BrandText | null = null;
const listeners = new Set<() => void>();

export function setBrandPreview(next: BrandText | null): void {
  preview = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅草稿覆盖；null 表示用已保存的设置。 */
export function useBrandPreview(): BrandText | null {
  const [current, setCurrent] = useState<BrandText | null>(preview);
  useEffect(() => subscribe(() => setCurrent(preview)), []);
  return current;
}

/** 草稿优先 → 已保存设置 → 内置默认；界面统一按单行省略展示。 */
export function resolveBrand(settings: Settings | null, draft: BrandText | null): BrandText {
  const title = (draft?.title ?? settings?.brandTitle ?? "").trim();
  const subtitle = (draft?.subtitle ?? settings?.brandSubtitle ?? "").trim();
  return {
    title: title || DEFAULT_BRAND.title,
    subtitle: subtitle || DEFAULT_BRAND.subtitle,
  };
}
