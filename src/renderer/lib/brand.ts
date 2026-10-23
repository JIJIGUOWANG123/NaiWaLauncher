/**
 * 侧边栏品牌文案：固定值，不再允许自定义（0.1.6 去掉了「品牌主标题/副标题」，
 * 顶部标题栏文字与界面图标仍可在个性化页改）。
 */
export const DEFAULT_BRAND = { title: "NaiWa", subtitle: "奶娃启动器" } as const;

export interface BrandText {
  title: string;
  subtitle: string;
}
