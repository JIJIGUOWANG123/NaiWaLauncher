import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DownloadSourceId, ModProviderId, Settings } from "../../shared/types";
import { logger, registerSecret } from "./logger";
import { getPaths } from "./paths";

const log = logger("settings");

/** 内置默认 CurseForge Key：用户可在设置页覆盖，空值回落为它。 */
// 发行版不内置 Key：CurseForge 官方 API 需使用者自行申请并在设置里填写，避免把凭据随安装包分发。
export const DEFAULT_CURSEFORGE_API_KEY = "";
/** 内置公共 Azure 应用 client id；用户手动填写后不再使用内置值。 */
export const BUILTIN_MICROSOFT_CLIENT_ID = "fd3e219a-6e6a-4188-8a39-e241f0e63324";

const SOURCE_IDS: DownloadSourceId[] = ["official", "bmclapi", "sjtu", "auto"];
const PROVIDER_IDS: ModProviderId[] = ["modrinth", "curseforge", "minekuai"];
const LANGUAGES: Settings["language"][] = ["zh-CN", "en-US"];

let cached: Settings | null = null;
let loaded = false;

/** 写盘串行化，避免并发 updateSettings 互相覆盖临时文件。 */
let writeQueue: Promise<void> = Promise.resolve();

export function defaults(): Settings {
  return {
    downloadSource: "auto",
    connectionsPerFile: 4,
    concurrentDownloads: 12,
    // 内置默认 Key，可在设置中替换
    curseforgeApiKey: "",
    modProvider: "modrinth",
    autoSwitchThresholdMs: 1500,
    javaAutoDownload: true,
    javaAutoMatch: true,
    language: "zh-CN",
    closeToTray: false,
    showRelease: true,
    showSnapshot: true,
    showLegacy: true,
    // 个性化默认值：菠萝黄 + 全不透明 + 启动动画开启 + 系统标题栏
    theme: "pineapple",
    accentColor: "#F6D365",
    uiOpacity: 1,
    showSplash: true,
    backgroundImage: "",
    backgroundMusic: "",
    musicVolume: 0.5,
    titleBar: "compact",
    titleBarText: "",
    backgroundMode: "single",
    backgroundIntervalSec: 20,
    // 默认开启渐变：预设主题保持渐变观感；滑稽彩/欧皇彩在 theme.ts 里按「未指定两色时退化为纯色」处理
    customGradient: true,
    gradientFrom: "",
    gradientTo: "",
    versionListSource: "auto",
    speedLimitKbps: 0,
    modFileNameTemplate: "[{name}] {slug}-{version}",
    modDisplayStyle: "title",
    notifyGameUpdates: true,
    forceChinese: true,
    versionIsolation: "all",
    windowTitle: "",
    launcherBrand: "NaiWa",
    launcherVisibility: "keep",
    processPriority: "normal",
    windowSize: "default",
    translateMods: true,
    translateSearch: true,
    // DeepL 免费版 Key（:fx 结尾 → api-free.deepl.com）；可在设置里替换或清空
    brandTitle: "",
    brandSubtitle: "",
    appIcon: "",
    startupSound: "",
    startupVolume: 0.6,
    natfrpToken: "",
    deeplApiKey: "0db97fea-a8ba-4356-bded-c1dc06475552:fx",
    activeAccountId: "",
    // 微软登录默认使用的 Azure 应用 client id（可在设置里替换）；
    // 该应用需在 Azure 门户开启「允许公共客户端流」，否则设备码登录会返回 AADSTS70002。
    microsoftClientId: BUILTIN_MICROSOFT_CLIENT_ID,
    microsoftClientIdManual: "",
  };
}

const THEME_IDS = [
  "dragon", "lemon", "grass", "pineapple", "oak", "midnight", "candy",
  "pink", "mystery", "lucky", "autumn", "orange", "red", "geek", "custom",
] as const;
const TITLE_BARS = ["compact", "image"] as const;
const BACKGROUND_MODES = ["single", "sequence", "random"] as const;
const VERSION_SOURCES = ["official", "bmclapi", "auto"] as const;
const MOD_DISPLAY = ["title", "filename"] as const;
const ISOLATIONS = ["all", "none"] as const;
const VISIBILITIES = ["keep", "minimize", "close"] as const;
const PRIORITIES = ["low", "normal", "high"] as const;

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 缺失或空串视为未设置 → 回落内置默认 Key；用户填了其它值绝不覆盖。 */
function pickApiKey(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

/** 以 base 为兜底逐字段校验，非法值一律回退，保证调用方永远拿到合法 Settings。 */
function normalize(raw: unknown, base: Settings): Settings {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    // fastmcmirror 已移除（镜像站长期不可达），旧配置自动回落为 auto
    downloadSource: pickEnum(src.downloadSource === "fastmcmirror" ? "auto" : src.downloadSource, SOURCE_IDS, base.downloadSource),
    connectionsPerFile: clampInt(src.connectionsPerFile, 1, 16, base.connectionsPerFile),
    // 多线程下载指「多个文件同时下载」：上限 32 给足并行度，默认 12 兼顾带宽与 CDN 限流
    concurrentDownloads: clampInt(src.concurrentDownloads, 1, 32, base.concurrentDownloads),
    curseforgeApiKey: pickApiKey(src.curseforgeApiKey, base.curseforgeApiKey),
    modProvider: pickEnum(src.modProvider, PROVIDER_IDS, base.modProvider),
    autoSwitchThresholdMs: clampInt(src.autoSwitchThresholdMs, 100, 60_000, base.autoSwitchThresholdMs),
    javaAutoDownload: pickBool(src.javaAutoDownload, base.javaAutoDownload),
    javaAutoMatch: pickBool(src.javaAutoMatch, base.javaAutoMatch),
    language: pickEnum(src.language, LANGUAGES, base.language),
    closeToTray: pickBool(src.closeToTray, base.closeToTray),
    showRelease: pickBool(src.showRelease, base.showRelease),
    showSnapshot: pickBool(src.showSnapshot, base.showSnapshot),
    showLegacy: pickBool(src.showLegacy, base.showLegacy),
    theme: pickEnum(src.theme, THEME_IDS, base.theme),
    accentColor: /^#[0-9a-fA-F]{6}$/.test(String(src.accentColor ?? "")) ? String(src.accentColor) : base.accentColor,
    uiOpacity: clampFloat(src.uiOpacity, 0.6, 1, base.uiOpacity),
    showSplash: pickBool(src.showSplash, base.showSplash),
    backgroundImage: pickString(src.backgroundImage, base.backgroundImage),
    backgroundMusic: pickString(src.backgroundMusic, base.backgroundMusic),
    musicVolume: clampFloat(src.musicVolume, 0, 1, base.musicVolume),
    // 旧配置里的 "default"（系统标题栏）已移除，统一迁移到 "compact"
    titleBar: pickEnum(src.titleBar === "default" ? "compact" : src.titleBar, TITLE_BARS, base.titleBar),
    titleBarText: pickString(src.titleBarText, base.titleBarText),
    backgroundMode: pickEnum(src.backgroundMode, BACKGROUND_MODES, base.backgroundMode),
    backgroundIntervalSec: clampInt(src.backgroundIntervalSec, 5, 600, base.backgroundIntervalSec),
    customGradient: pickBool(src.customGradient, base.customGradient),
    gradientFrom: /^#[0-9a-fA-F]{6}$/.test(String(src.gradientFrom ?? "")) ? String(src.gradientFrom) : base.gradientFrom,
    gradientTo: /^#[0-9a-fA-F]{6}$/.test(String(src.gradientTo ?? "")) ? String(src.gradientTo) : base.gradientTo,
    versionListSource: pickEnum(src.versionListSource, VERSION_SOURCES, base.versionListSource),
    speedLimitKbps: clampInt(src.speedLimitKbps, 0, 1_000_000, base.speedLimitKbps),
    modFileNameTemplate: pickString(src.modFileNameTemplate, base.modFileNameTemplate),
    modDisplayStyle: pickEnum(src.modDisplayStyle, MOD_DISPLAY, base.modDisplayStyle),
    notifyGameUpdates: pickBool(src.notifyGameUpdates, base.notifyGameUpdates),
    forceChinese: pickBool(src.forceChinese, base.forceChinese),
    versionIsolation: pickEnum(src.versionIsolation, ISOLATIONS, base.versionIsolation),
    windowTitle: pickString(src.windowTitle, base.windowTitle),
    launcherBrand: pickString(src.launcherBrand, base.launcherBrand),
    launcherVisibility: pickEnum(src.launcherVisibility, VISIBILITIES, base.launcherVisibility),
    processPriority: pickEnum(src.processPriority, PRIORITIES, base.processPriority),
    windowSize: pickString(src.windowSize, base.windowSize),
    translateMods: pickBool(src.translateMods, base.translateMods),
    translateSearch: pickBool(src.translateSearch, base.translateSearch),
    brandTitle: pickString(src.brandTitle, base.brandTitle).slice(0, 24),
    brandSubtitle: pickString(src.brandSubtitle, base.brandSubtitle).slice(0, 32),
    appIcon: pickString(src.appIcon, base.appIcon),
    startupSound: pickString(src.startupSound, base.startupSound),
    startupVolume: clampFloat(src.startupVolume, 0, 1, base.startupVolume),
    natfrpToken: pickString(src.natfrpToken, base.natfrpToken).trim(),
    deeplApiKey: pickString(src.deeplApiKey, base.deeplApiKey).trim(),
    activeAccountId: pickString(src.activeAccountId, base.activeAccountId),
    // 留空 = 使用内置的共用 client id（不写入空值，避免界面误判为未配置）
    // 手动优先，留空即用内置；同时把生效值同步到 microsoftClientId 供登录模块直接使用
    microsoftClientIdManual: pickString(src.microsoftClientIdManual, base.microsoftClientIdManual).trim(),
    microsoftClientId: (pickString(src.microsoftClientIdManual, base.microsoftClientIdManual).trim() || BUILTIN_MICROSOFT_CLIENT_ID),
  };
}

async function writeAtomic(next: Settings): Promise<void> {
  const file = getPaths().settingsFile;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    // rename 是原子替换，避免崩溃时留下半截 json
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function persist(next: Settings): Promise<void> {
  const run = writeQueue.then(
    () => writeAtomic(next),
    () => writeAtomic(next),
  );
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function loadSettings(): Promise<Settings> {
  loaded = true;
  const base = defaults();
  let text: string;
  try {
    text = await readFile(getPaths().settingsFile, "utf8");
  } catch {
    cached = base;
    return cached;
  }
  try {
    cached = normalize(JSON.parse(text), base);
  } catch {
    log.warn("设置文件损坏，已回退到默认值");
    cached = base;
  }
  registerSecret(cached.curseforgeApiKey);
  if (cached.deeplApiKey) registerSecret(cached.deeplApiKey);
  if (cached.natfrpToken) registerSecret(cached.natfrpToken);
  return cached;
}

export function getSettings(): Settings {
  return cached ? { ...cached } : defaults();
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  if (!loaded) await loadSettings();
  const next = normalize({ ...(cached ?? defaults()), ...patch }, defaults());
  // 先更新缓存：调用方在写盘完成前读到旧值会造成状态不一致
  cached = next;
  registerSecret(next.curseforgeApiKey);
  if (next.deeplApiKey) registerSecret(next.deeplApiKey);
  if (next.natfrpToken) registerSecret(next.natfrpToken);
  try {
    await persist(next);
  } catch (err) {
    log.error(`设置写入失败：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  return { ...next };
}
