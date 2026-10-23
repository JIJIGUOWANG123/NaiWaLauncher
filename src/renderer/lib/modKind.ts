import type { ModFilesRequest, ModInstallRequest, ModSearchRequest } from "../../shared/ipc";
import type { LoaderKind, ModContentKind, ModProviderId } from "../../shared/types";
import { loaderLabel } from "./format";

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

/** 后端真正实现了的 kind（数据包尚未落地）。 */
export function isBackendKind(kind: UiContentKind): kind is ModContentKind {
  return kind !== "datapack";
}

/** 一级标签：顺序与「资源」页顶部一致。 */
export const KIND_TABS: Array<{ value: UiContentKind; label: string; disabled?: boolean; hint?: string }> = [
  { value: "modpack", label: "整合包" },
  { value: "mod", label: "模组" },
  { value: "resourcepack", label: "资源包" },
  { value: "datapack", label: "数据包", disabled: true, hint: "数据包暂不支持：后端还没有对应接口" },
  { value: "map", label: "地图" },
  { value: "shader", label: "光影包" },
];

/** 卡片上的类型徽标；模组是默认内容，不加徽标。 */
export const KIND_BADGE: Record<ModContentKind, string | null> = {
  mod: null,
  shader: "光影",
  resourcepack: "资源包",
  modpack: "整合包",
  map: "地图",
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
export const KIND_INSTALL_LABEL: Record<ModContentKind, string> = {
  mod: "安装到实例",
  shader: "安装到 shaderpacks",
  resourcepack: "安装到 resourcepacks",
  modpack: "安装并创建实例",
  map: "下载",
};

/** 文件行里的按钮文案（比底部按钮短，避免撑破行宽）。 */
export const KIND_FILE_ACTION: Record<ModContentKind, string> = {
  mod: "安装",
  shader: "安装",
  resourcepack: "安装",
  modpack: "安装并创建实例",
  map: "下载",
};

/** 搜索框占位符。 */
export const KIND_PLACEHOLDER: Record<UiContentKind, string> = {
  mod: "支持中文，例如：钠 / 光影",
  shader: "支持中文，例如：清新光影 / BSL",
  resourcepack: "支持中文，例如：材质 / 原版增强",
  modpack: "支持中文，例如：空岛 / 工业",
  datapack: "数据包暂不支持",
  map: "支持中文，例如：空岛 / 生存",
};

export function kindLabel(kind: UiContentKind): string {
  return KIND_TABS.find((tab) => tab.value === kind)?.label ?? kind;
}

/** 结果为空时的提示。 */
export const KIND_EMPTY_HINT: Record<UiContentKind, string> = {
  mod: "换个关键词试试，或切换来源。",
  shader: "换个关键词试试，或清空左侧筛选。",
  resourcepack: "换个关键词试试，或清空左侧筛选。",
  modpack: "换个关键词试试，或清空左侧筛选。",
  datapack: "数据包暂不支持。",
  map: "换个关键词试试，地图列表来自麦块社区。",
};

/** 卡片上的来源徽标。 */
export const SOURCE_BADGE: Record<ModProviderId, string> = {
  modrinth: "Modrinth",
  curseforge: "CurseForge",
  minekuai: "麦块",
};

/** 排序下拉。 */
export const SORT_OPTIONS: Array<{ value: ModSort; label: string }> = [
  { value: "relevance", label: "相关性" },
  { value: "downloads", label: "下载量" },
  { value: "updated", label: "最近更新" },
];

const LOADER_KINDS: readonly string[] = ["vanilla", "fabric", "quilt", "forge", "neoforge", "liteloader"];

/** 加载器下拉的文案：已知加载器走中文标签，未知值原样显示。 */
export function loaderOptionLabel(value: string): string {
  return LOADER_KINDS.includes(value) ? loaderLabel(value as LoaderKind) : value;
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
export const MAPS_NOTICE = "地图列表来自麦块社区；下载需登录，启动器暂只支持浏览与版本适配提示";
/** 麦块社区的地图页：没有直链时让用户在浏览器里下载。 */
export const MAPS_WEB_URL = "https://bbs.minekuai.com/resources/maps";
/** 无直链时按钮旁的提示。 */
export const MAPS_LOGIN_HINT = "需登录麦块社区下载";