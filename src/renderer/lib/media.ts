import type { MediaList } from "../../shared/types";

const ABSOLUTE = /^(data:|file:|https?:|blob:)/i;

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
  return toFileUrl(`${dir.replace(/[\\/]+$/, "")}/${name}`);
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
