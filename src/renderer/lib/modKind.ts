import type { ModFilesRequest, ModInstallRequest, ModSearchRequest } from "../../shared/ipc";
import type { LoaderKind, ModContentKind, ModProviderId } from "../../shared/types";
import { loaderLabel, type Translate } from "./format";

/**
 * 渲染层的内容类型比 shared/types 多一个 datapack：
 * 后端接口还没有数据包，标签先占位并在 UI 上禁用。
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

/** 一级标签：顺序与「资源」页顶部一致。 */
export const KIND_TABS: Array<{ value: UiContentKind; labelKey: string; disabled?: boolean; hintKey?: string }> = [
  { value: "modpack", labelKey: "pages.mods.kindModpack" },
  { value: "mod", labelKey: "pages.mods.kindMod" },
  { value: "resourcepack", labelKey: "pages.mods.kindResourcepack" },
  { value: "datapack", labelKey: "pages.mods.kindDatapack", disabled: true, hintKey: "pages.mods.kindDatapackHint" },
  { value: "map", labelKey: "pages.mods.kindMap" },
  { value: "shader", labelKey: "pages.mods.kindShader" },
];

/** 卡片上的类型徽标；模组是默认内容，不加徽标。 */
export const KIND_BADGE_KEY: Record<ModContentKind, string | null> = {
  mod: null,
  shader: "pages.mods.badgeShader",
  resourcepack: "pages.mods.badgeResourcepack",
  modpack: "pages.mods.badgeModpack",
  map: "pages.mods.badgeMap",
};

/** 主进程按 kind 落盘到不同目录，提示文案里要写出目录名。 */
export const KIND_DIR: Record<ModContentKind, string> = {
  mod: "mods",
  shader: "shaderpacks",
  resourcepack: "resourcepacks",
  modpack: "modpacks",
  map: "saves",
};

/** 详情面板底部安装按钮文案。 */
export const KIND_INSTALL_LABEL_KEY: Record<ModContentKind, string> = {
  mod: "pages.mods.installMod",
  shader: "pages.mods.installShader",
  resourcepack: "pages.mods.installResourcepack",
  modpack: "pages.mods.installAndCreate",
  map: "pages.mods.installMap",
};

/** 文件行里的按钮文案（比底部按钮短，避免撑破行宽）。 */
export const KIND_FILE_ACTION_KEY: Record<ModContentKind, string> = {
  mod: "pages.mods.fileActionInstall",
  shader: "pages.mods.fileActionInstall",
  resourcepack: "pages.mods.fileActionInstall",
  modpack: "pages.mods.installAndCreate",
  map: "pages.mods.installMap",
};

/** 搜索框占位符。 */
export const KIND_PLACEHOLDER_KEY: Record<UiContentKind, string> = {
  mod: "pages.mods.placeholderMod",
  shader: "pages.mods.placeholderShader",
  resourcepack: "pages.mods.placeholderResourcepack",
  modpack: "pages.mods.placeholderModpack",
  datapack: "pages.mods.placeholderDatapack",
  map: "pages.mods.placeholderMap",
};

export function kindLabel(kind: UiContentKind, tr: Translate): string {
  const key = KIND_TABS.find((tab) => tab.value === kind)?.labelKey;
  return key ? tr(key) : kind;
}

/** 结果为空时的提示。 */
export const KIND_EMPTY_HINT_KEY: Record<UiContentKind, string> = {
  mod: "pages.mods.emptyHintMod",
  shader: "pages.mods.emptyHintFilter",
  resourcepack: "pages.mods.emptyHintFilter",
  modpack: "pages.mods.emptyHintFilter",
  datapack: "pages.mods.emptyHintDatapack",
  map: "pages.mods.emptyHintMap",
};

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

/** 地图来源说明（页面顶部固定展示）。 */
export const MAPS_NOTICE_KEY = "pages.mods.mapsNotice";
/** 麦块社区的地图页：没有直链时让用户在浏览器里下载。 */
export const MAPS_WEB_URL = "https://bbs.minekuai.com/resources/maps";
/** 无直链时按钮旁的提示。 */
export const MAPS_LOGIN_HINT_KEY = "pages.mods.mapsLoginHint";
