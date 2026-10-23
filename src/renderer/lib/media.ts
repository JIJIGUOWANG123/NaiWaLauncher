import type { MediaList } from "../../shared/types";

const ABSOLUTE = /^(data:|file:|https?:|blob:)/i;
/** Windows 盘符路径（F:\…）与 UNC 共享路径（\\server\share）：Wallpaper Engine 壁纸就是这种。 */
const WIN_ABS = /^[a-zA-Z]:[\\/]/;
const UNC_ABS = /^\\\\[^\\]/;

/** 绝对路径 → file:// URL；空格与中文由 encodeURI 处理。 */
export function toFileUrl(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  if (ABSOLUTE.test(normalized)) return normalized;
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`;
  return `file://${encodeURI(normalized.startsWith("/") ? normalized : `/${normalized}`)}`;
}

/**
 * dirs.backgrounds + "/" + 文件名，再 encodeURI（契约约定的拼法）。
 * 已经是 data:/file:/http: 的绝对地址原样返回，方便预览与测试。
 */
export function mediaUrl(dir: string, name: string): string {
  if (!name) return "";
  if (ABSOLUTE.test(name)) return name;
  // 盘符/UNC 绝对路径（例如 Wallpaper Engine 的壁纸视频）不能当「目录下的文件名」拼接，
  // 否则会得到 ...\NaiWa\backgrounds\F:\SteamLibrary\... 这种非法 URL，视频直接不加载。
  if (WIN_ABS.test(name) || UNC_ABS.test(name)) return toFileUrl(name);
  return toFileUrl(`${dir.replace(/[\\/]+$/, "")}/${name}`);
}

/** 能当背景播放的视频扩展名（背景资源目录里图片与视频混放）。 */
const VIDEO_EXT = /\.(mp4|webm|ogv)$/i;

/**
 * 背景资源是视频还是图片：按扩展名判断，data: 内联样例按 MIME 判断。
 * App 的背景层与个性化页的预览、文案都共用这一个判断。
 */
export function isVideoFile(name: string): boolean {
  if (!name) return false;
  if (/^data:video\//i.test(name)) return true;
  const withoutQuery = name.split(/[?#]/)[0];
  return VIDEO_EXT.test(withoutQuery);
}

/** 背景图片 URL：列表尚未返回时也能处理 data:/file: 绝对地址。 */
export function backgroundUrl(list: MediaList | null, name: string): string {
  return mediaUrl(list?.dirs.backgrounds ?? "", name);
}

export function musicUrl(list: MediaList | null, name: string): string {
  return mediaUrl(list?.dirs.music ?? "", name);
}

/** 下拉/缩略图用的短标签：data: 内置样例不展开成长串（多张时按序号区分）。 */
export function mediaLabel(name: string, index?: number): string {
  if (!/^data:/i.test(name)) return name;
  return typeof index === "number" ? `内置样例 ${index + 1}` : "内置样例";
}
