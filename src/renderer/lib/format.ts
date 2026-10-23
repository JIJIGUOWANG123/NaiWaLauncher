import type { InstanceMeta, LoaderKind, VersionBrief } from "../../shared/types";

/**
 * 文案翻译器：签名与 lib/i18n.ts 的 useT() / t() 一致。
 * 本文件只产出「数字 + 单位」，带语序的文案统一走词条 key，由调用方传入 tr。
 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

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

/** 一万以上折算成缩写单位，卡片上不撑破布局（中文万/亿，英文 K/M，日文万/億）。 */
export function formatCount(count: number, tr: Translate): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const trim = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, ""));
  if (count >= 100000000) return tr("pages.format.countYi", { value: trim(count / 100000000) });
  if (count >= 10000) return tr("pages.format.countWan", { value: trim(count / 10000) });
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

export function formatRelative(timestamp: number | undefined, tr: Translate): string {
  if (!timestamp) return tr("pages.format.relativeNeverStarted");
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return tr("pages.format.relativeJustStarted");
  if (diff < 60 * 60 * 1000) return tr("pages.format.agoMinutes", { count: Math.floor(diff / 60000) });
  if (diff < 24 * 60 * 60 * 1000) return tr("pages.format.agoHours", { count: Math.floor(diff / 3600000) });
  if (diff < 30 * 24 * 60 * 60 * 1000) return tr("pages.format.agoDays", { count: Math.floor(diff / 86400000) });
  return formatDate(new Date(timestamp).toISOString());
}

export function formatLatency(ms: number | null, ok: boolean, tr: Translate): string {
  if (!ok || ms === null) return tr("pages.format.latencyUnavailable");
  return `${Math.round(ms)} ms`;
}

/** 加载器展示名：原版走词典，其余是专有名词保持英文，未知值原样输出。 */
export function loaderLabel(loader: LoaderKind, tr: Translate): string {
  switch (loader) {
    case "vanilla":
      return tr("pages.format.loaderVanilla");
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
export function liteloaderVersionHint(tr: Translate): string {
  return tr("pages.format.liteloaderMaxVersion", { version: LITELOADER_MAX_VERSION });
}

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

export function versionTypeLabel(type: VersionBrief["type"], tr: Translate): string {
  switch (type) {
    case "release":
      return tr("pages.format.versionRelease");
    case "snapshot":
      return tr("pages.format.versionSnapshot");
    case "old_beta":
      return tr("pages.format.versionOldBeta");
    case "old_alpha":
      return tr("pages.format.versionOldAlpha");
    default:
      return String(type);
  }
}

export function releaseTypeLabel(type: "release" | "beta" | "alpha", tr: Translate): string {
  if (type === "release") return tr("pages.format.releaseStable");
  if (type === "beta") return tr("pages.format.releaseBeta");
  return tr("pages.format.releaseAlpha");
}

/** 资源卡片的更新时间：「3 天前」这类相对说法，超过一个月退回日期。 */
export function formatAgo(iso: string | undefined, tr: Translate): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60 * 1000) return tr("pages.format.agoJustNow");
  if (diff < 60 * 60 * 1000) return tr("pages.format.agoMinutes", { count: Math.floor(diff / 60000) });
  if (diff < 24 * 60 * 60 * 1000) return tr("pages.format.agoHours", { count: Math.floor(diff / 3600000) });
  if (diff < 30 * 24 * 60 * 60 * 1000) return tr("pages.format.agoDays", { count: Math.floor(diff / 86400000) });
  return formatDate(new Date(time).toISOString());
}

export function instanceMemory(instance: InstanceMeta): string {
  return instance.memoryMb >= 1024 ? `${instance.memoryMb / 1024} GB` : `${instance.memoryMb} MB`;
}

/** 实例目录占用量：尚未统计（缺省）时说「计算中…」，统计到 0 也照实显示 "0 B"。 */
export function instanceDiskUsage(instance: InstanceMeta, tr: Translate): string {
  const bytes = instance.diskUsageBytes;
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return tr("pages.format.diskCalculating");
  return formatBytes(bytes);
}
