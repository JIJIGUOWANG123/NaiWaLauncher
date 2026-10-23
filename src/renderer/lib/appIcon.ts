import logo from "../assets/logo.png";
import { api } from "./api";

/** api.app.appIcon() 的渲染层快照；url 为空表示改用内置 logo。 */
export interface AppIconInfo {
  url: string | null;
  path: string | null;
}

export const NO_APP_ICON: AppIconInfo = { url: null, path: null };

/**
 * 归一化主进程结果：任何异常或字段缺失都退回「无自定义图标」，
 * 界面继续用内置 logo，不让图标问题阻断启动。
 */
export async function fetchAppIcon(): Promise<AppIconInfo> {
  try {
    const result = await api.app.appIcon();
    return { url: result?.url ?? null, path: result?.path ?? null };
  } catch {
    return NO_APP_ICON;
  }
}

/** 有自定义图标就用它，否则回落到打包进 assets 的内置 logo；标题栏/侧边栏/启动屏/实例头像共用。 */
export function iconSrc(iconUrl: string | null): string {
  return iconUrl || logo;
}

/**
 * 打开 NaiWa/icons。契约只给了 media.openDir("icons")，
 * shared/ipc 的联合类型还停在 backgrounds/music，这里断言一次即可。
 */
export async function openIconsDir(): Promise<void> {
  await api.media.openDir("icons" as "backgrounds");
}
