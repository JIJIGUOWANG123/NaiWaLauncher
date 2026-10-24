import type { ModFilesRequest, ModInstallRequest, ModSearchRequest, ServerCapabilities } from "../../shared/ipc";
import type { LoaderKind, ModContentKind, ModProviderId, ServerCoreId } from "../../shared/types";
import { loaderLabel, type Translate } from "./format";

/**
 * 渲染层的内容类型比 shared/types 多一个 datapack：
 * 数据包入口已从「来源」里撤掉，类型保留只是为了兼容旧的本地筛选记忆与 isBackendKind 的收窄。
 * plugin（服务端插件）装进「开服」里的服务端，不进客户端实例。
 */
export type UiContentKind = ModContentKind | "datapack";

/** 来源筛选：资源页已改成「站点单选」，all 仅作为类型占位保留。 */
export type ModSourceFilter = ModProviderId | "all";

/** 结果排序。 */
export type ModSort = "relevance" | "downloads" | "updated";

/** 请求类型 + kind：kind 已经是 shared/ipc.ts 的可选字段，这里只把它固定下来。 */
export type KindSearchRequest = ModSearchRequest & { kind: ModContentKind };
export type KindFilesRequest = ModFilesRequest & { kind: ModContentKind };
export type KindInstallRequest = ModInstallRequest & { kind: ModContentKind };

/** 翻译器类型统一由 lib/format.ts 提供，这里转出去给页面按需引用。 */
export type { Translate };

/** 后端真正实现了的 kind（数据包尚未落地）。 */
export function isBackendKind(kind: UiContentKind): kind is ModContentKind {
  return kind !== "datapack";
}

/** 一级标签：顺序与「资源」页顶部一致。插件排在光影之后。 */
export const KIND_TABS: Array<{ value: UiContentKind; labelKey: string }> = [
  { value: "modpack", labelKey: "pages.mods.kindModpack" },
  { value: "mod", labelKey: "pages.mods.kindMod" },
  { value: "resourcepack", labelKey: "pages.mods.kindResourcepack" },
  { value: "shader", labelKey: "pages.mods.kindShader" },
  { value: "plugin", labelKey: "pages.mods.kindPlugin" },
];

/** 卡片上的类型徽标；模组是默认内容，不加徽标。 */
export const KIND_BADGE_KEY: Record<ModContentKind, string | null> = {
  mod: null,
  shader: "pages.mods.badgeShader",
  resourcepack: "pages.mods.badgeResourcepack",
  modpack: "pages.mods.badgeModpack",
  map: "pages.mods.badgeMap",
  plugin: "pages.mods.badgePlugin",
};

/** 主进程按 kind 落盘到不同目录，提示文案里要写出目录名。插件落在服务端的 plugins 目录。 */
export const KIND_DIR: Record<ModContentKind, string> = {
  mod: "mods",
  shader: "shaderpacks",
  resourcepack: "resourcepacks",
  modpack: "modpacks",
  map: "saves",
  plugin: "plugins",
};

/** 详情面板底部安装按钮文案。 */
export const KIND_INSTALL_LABEL_KEY: Record<ModContentKind, string> = {
  mod: "pages.mods.installMod",
  shader: "pages.mods.installShader",
  resourcepack: "pages.mods.installResourcepack",
  modpack: "pages.mods.installAndCreate",
  map: "pages.mods.installMap",
  plugin: "pages.mods.pluginInstall",
};

/** 文件行里的按钮文案（比底部按钮短，避免撑破行宽）。 */
export const KIND_FILE_ACTION_KEY: Record<ModContentKind, string> = {
  mod: "pages.mods.fileActionInstall",
  shader: "pages.mods.fileActionInstall",
  resourcepack: "pages.mods.fileActionInstall",
  modpack: "pages.mods.installAndCreate",
  map: "pages.mods.installMap",
  plugin: "pages.mods.pluginInstall",
};

/** 搜索框占位符。 */
export const KIND_PLACEHOLDER_KEY: Record<UiContentKind, string> = {
  mod: "pages.mods.placeholderMod",
  shader: "pages.mods.placeholderShader",
  resourcepack: "pages.mods.placeholderResourcepack",
  modpack: "pages.mods.placeholderModpack",
  datapack: "pages.mods.placeholderDatapack",
  map: "pages.mods.placeholderMap",
  plugin: "pages.mods.placeholderPlugin",
};

export function kindLabel(kind: UiContentKind, tr: Translate): string {
  const key = KIND_TABS.find((tab) => tab.value === kind)?.labelKey;
  return key ? tr(key) : kind;
}

/** 卡片上的来源徽标：Modrinth / CurseForge 是专有名词，麦块走词典。 */
export function sourceBadge(provider: ModProviderId, tr: Translate): string {
  if (provider === "minekuai") return tr("pages.mods.badgeMinekuai");
  return provider === "modrinth" ? "Modrinth" : "CurseForge";
}

/** 排序下拉。 */
export const SORT_OPTIONS_KEY: Array<{ value: ModSort; labelKey: string }> = [
  { value: "relevance", labelKey: "pages.mods.sortRelevance" },
  { value: "downloads", labelKey: "pages.mods.sortDownloads" },
  { value: "updated", labelKey: "pages.mods.sortUpdated" },
];

const LOADER_KINDS: readonly string[] = ["vanilla", "fabric", "quilt", "forge", "neoforge", "liteloader"];

/** 加载器下拉的文案：原版走词典，其余加载器是专有名词，未知值原样显示。 */
export function loaderOptionLabel(value: string, tr: Translate): string {
  if (value === "vanilla") return tr("pages.mods.loaderVanilla");
  return LOADER_KINDS.includes(value) ? loaderLabel(value as LoaderKind, tr) : value;
}

/** 加载器下拉只在模组 / 整合包下出现。 */
export function showsLoader(kind: UiContentKind): boolean {
  return kind === "mod" || kind === "modpack";
}

/** 分辨率下拉只在资源包下出现：光影没有分辨率的概念。 */
export function showsResolution(kind: UiContentKind): boolean {
  return kind === "resourcepack";
}

/**
 * 服务端核心 → 它能加载的插件平台。
 * core 的取值以 shared/types.ts 的 ServerCoreId 为准（Vanilla / Paper / Purpur / Folia / Fabric / Forge / NeoForge / Arclight）。
 * 插件服之间互相兼容，所以纸系核心给的是整族平台；模组服给空数组（插件根本不加载）。
 */
export const CORE_PLUGIN_PLATFORMS: Record<ServerCoreId, string[]> = {
  Vanilla: ["bukkit"],
  Arclight: ["bukkit"],
  Paper: ["paper", "purpur", "folia", "bukkit", "spigot"],
  Purpur: ["paper", "purpur", "folia", "bukkit", "spigot"],
  Folia: ["paper", "purpur", "folia", "bukkit", "spigot"],
  Fabric: [],
  Forge: [],
  NeoForge: [],
};

/** 核心不是 ServerCoreId 的八个取值时（以后加 Velocity / Waterfall）的兜底映射。 */
const EXTRA_CORE_PLATFORMS: Record<string, string[]> = {
  velocity: ["velocity"],
  waterfall: ["waterfall", "bungeecord"],
  bungeecord: ["waterfall", "bungeecord"],
};

const MODDED_CORES: readonly string[] = ["fabric", "forge", "neoforge", "quilt"];

/** 这个核心能加载哪些插件平台；未知核心按 bukkit 处理（与「插件服互相兼容」同一口径）。 */
export function pluginPlatformsOfCore(core: string): string[] {
  if (Object.hasOwn(CORE_PLUGIN_PLATFORMS, core)) return CORE_PLUGIN_PLATFORMS[core as ServerCoreId];
  return EXTRA_CORE_PLATFORMS[core.toLowerCase()] ?? ["bukkit"];
}

/** 模组服：插件装进去不会加载，插件类型整体提示一句并禁用安装。 */
export function isModdedServerCore(core: string): boolean {
  return MODDED_CORES.includes(core.toLowerCase());
}

/** 一次「文件平台 vs 目标核心」的判断结果。 */
export interface PluginPlatformCheck {
  /** 文件声明的平台（小写去重）；空数组＝文件没写平台，按通用文件处理。 */
  filePlatforms: string[];
  /** 目标核心能加载的平台；空数组＝模组服。 */
  serverPlatforms: string[];
  /** 文件写了平台、且与目标核心一个都不重合。 */
  mismatch: boolean;
}

/** 插件文件能否在目标核心上生效：不拦安装，只用来提示（用户可能就是想换核心）。 */
export function checkPluginPlatform(loaders: readonly string[], core: string): PluginPlatformCheck {
  const filePlatforms = Array.from(new Set(loaders.map((item) => item.trim().toLowerCase()).filter(Boolean)));
  const serverPlatforms = pluginPlatformsOfCore(core);
  const mismatch = filePlatforms.length > 0
    && serverPlatforms.length > 0
    && !filePlatforms.some((item) => serverPlatforms.includes(item));
  return { filePlatforms, serverPlatforms, mismatch };
}

/**
 * 按服务端核心推能力：servers:capabilities 的首屏兜底（拿不到主进程结果时顶上，页面只认这个形状）。
 */
export function serverCapabilitiesOf(core: string): ServerCapabilities {
  const key = core.toLowerCase();
  // Arclight 是 Forge + Bukkit 混合端：模组与插件都能装，不能按纯插件服处理
  if (key === "arclight") return { core, modded: true, plugins: true };
  const modded = isModdedServerCore(core);
  const plugins = !modded && key !== "vanilla" && pluginPlatformsOfCore(core).length > 0;
  return { core, modded, plugins };
}

/** 这个类型能不能装进服务端：mod → mods 目录，plugin → plugins 目录，其余只能装实例。 */
export function serverContentKindOf(kind: UiContentKind): "mod" | "plugin" | null {
  if (kind === "mod") return "mod";
  return kind === "plugin" ? "plugin" : null;
}

/** 某类型 + 某核心能不能装：allowed=false 时 reasonKey 是给用户看的原因。 */
export interface ServerTargetGate {
  allowed: boolean;
  reasonKey: string | null;
}

export function serverTargetGate(kind: UiContentKind, core: string): ServerTargetGate {
  return serverTargetGateFor(kind, serverCapabilitiesOf(core));
}

/** 与 servers:capabilities 返回同形的判断（主进程给了能力表就直接用它）。 */
export function serverTargetGateFor(
  kind: UiContentKind,
  caps: Pick<ServerCapabilities, "modded" | "plugins">,
): ServerTargetGate {
  if (kind === "plugin") {
    if (caps.plugins) return { allowed: true, reasonKey: null };
    return { allowed: false, reasonKey: caps.modded ? "pages.mods.pluginOnModdedServer" : "pages.mods.pluginOnVanillaServer" };
  }
  if (kind === "mod") {
    if (caps.modded) return { allowed: true, reasonKey: null };
    return { allowed: false, reasonKey: caps.plugins ? "pages.mods.modOnPluginServer" : "pages.mods.modOnVanillaServer" };
  }
  return { allowed: false, reasonKey: "pages.mods.serverTargetUnsupported" };
}

/** 实例目标门禁：allowed=false 时 reasonKey 是给用户看的原因。 */
export interface InstanceTargetGate {
  allowed: boolean;
  reasonKey: string | null;
}

/**
 * 原版实例不能装模组 / 光影：没有加载器就没有加载器入口，装进去也不会被读。
 * 资源包原版能用（客户端自带资源包系统），整合包本来就是新建实例，两者都不受此限。
 */
export function instanceTargetGate(kind: UiContentKind, loader: string): InstanceTargetGate {
  if (kind !== "mod" && kind !== "shader") return { allowed: true, reasonKey: null };
  if (loader !== "vanilla") return { allowed: true, reasonKey: null };
  return { allowed: false, reasonKey: "pages.mods.instanceVanillaBlocked" };
}

/** 选好实例后要不要先挑版本：整合包新建实例、插件进服务端目录，都没有「对实例挑版本」这一步。 */
export function needsVersionPick(kind: UiContentKind): boolean {
  return kind !== "modpack" && kind !== "plugin";
}

/**
 * 「安装到…」弹窗里的两组目标。模组两组都能装；插件只进服务端（实例里没有 plugins 目录）；
 * 整合包/资源包/光影包只能进实例，服务端组根本不该出现。
 */
export type TargetGroupId = "instance" | "server";

/** 某个类型在弹窗里要显示哪几组，顺序即渲染顺序。 */
export function targetGroupsOf(kind: UiContentKind): TargetGroupId[] {
  if (kind === "plugin") return ["server"];
  if (kind === "mod") return ["instance", "server"];
  return ["instance"];
}

/** 分组标题的词典键：实例 / 服务端。 */
export const TARGET_GROUP_LABEL_KEY: Record<TargetGroupId, string> = {
  instance: "pages.mods.targetInstances",
  server: "pages.mods.targetServers",
};

/** 地图来源说明（页面顶部固定展示）。 */
export const MAPS_NOTICE_KEY = "pages.mods.mapsNotice";
/** 麦块社区的地图页：没有直链时让用户在浏览器里下载。 */
export const MAPS_WEB_URL = "https://bbs.minekuai.com/resources/maps";
/** 无直链时按钮旁的提示。 */
export const MAPS_LOGIN_HINT_KEY = "pages.mods.mapsLoginHint";
