import type { InstanceMeta, LoaderKind, VersionBrief } from "../../shared/types";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "—";
  return `${Math.round(Math.max(0, Math.min(1, percent)) * 100)}%`;
}

/** 一万以上折算为中文单位，卡片上不撑破布局。 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const trim = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, ""));
  if (count >= 100000000) return `${trim(count / 100000000)} 亿`;
  if (count >= 10000) return `${trim(count / 10000)} 万`;
  return String(Math.round(count));
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 绝对时间（月-日 时:分），下载记录这类不按「几分钟前」读更准的场景用。 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRelative(timestamp?: number): string {
  if (!timestamp) return "尚未启动";
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return "刚刚启动过";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(new Date(timestamp).toISOString());
}

export function formatLatency(ms: number | null, ok: boolean): string {
  if (!ok || ms === null) return "不可用";
  return `${Math.round(ms)} ms`;
}

export function loaderLabel(loader: LoaderKind): string {
  switch (loader) {
    case "vanilla":
      return "原版";
    case "fabric":
      return "Fabric";
    case "quilt":
      return "Quilt";
    case "forge":
      return "Forge";
    case "neoforge":
      return "NeoForge";
    case "liteloader":
      return "LiteLoader";
    default:
      return loadersFallback(loader);
  }
}

function loadersFallback(loader: never): string {
  return String(loader);
}

/** LiteLoader 只支持 1.12.2 及更早版本。 */
export const LITELOADER_MAX_VERSION = "1.12.2";

/** 提示文案：LiteLoader 与过高 MC 版本不兼容时显示。 */
export const LITELOADER_VERSION_HINT = `LiteLoader 只支持 ${LITELOADER_MAX_VERSION} 及更早版本`;

function parseMcVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * 该 MC 版本是否超出 LiteLoader 的支持范围。
 * 解析不出的版本（例如快照 24w50a）按不支持处理——LiteLoader 只跟随正式版。
 */
export function liteloaderUnsupported(mcVersion: string): boolean {
  const current = parseMcVersion(mcVersion);
  if (!current) return true;
  const [major, minor, patch] = current;
  if (major !== 1) return major > 1;
  if (minor !== 12) return minor > 12;
  return patch > 2;
}

export function versionTypeLabel(type: VersionBrief["type"]): string {
  switch (type) {
    case "release":
      return "正式版";
    case "snapshot":
      return "快照";
    case "old_beta":
      return "远古 Beta";
    case "old_alpha":
      return "远古 Alpha";
    default:
      return String(type);
  }
}

export function releaseTypeLabel(type: "release" | "beta" | "alpha"): string {
  if (type === "release") return "稳定版";
  if (type === "beta") return "测试版";
  return "预览版";
}

/** 资源卡片的更新时间：「3 天前」这类相对说法，超过一个月退回日期。 */
export function formatAgo(iso?: string): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(new Date(time).toISOString());
}

export function instanceMemory(instance: InstanceMeta): string {
  return instance.memoryMb >= 1024 ? `${instance.memoryMb / 1024} GB` : `${instance.memoryMb} MB`;
}

/** 实例目录占用量：尚未统计（缺省）时说「计算中…」，统计到 0 也照实显示 "0 B"。 */
export function instanceDiskUsage(instance: InstanceMeta): string {
  const bytes = instance.diskUsageBytes;
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return "计算中…";
  return formatBytes(bytes);
}
