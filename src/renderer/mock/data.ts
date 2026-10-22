import type {
  Account, AppInfo, DownloadSourceInfo, InstanceMeta, InstalledJava, InstalledModInfo, JavaRelease, LoaderKind,
  LoaderVersionInfo, MapEntry, ModContentKind, ModDependency, ModDetail, ModFileInfo, ModSearchResult, SaveInfo,
  Settings, VersionBrief,
} from "../../shared/types";

export const MOCK_ROOT = "D:\\NaiWa Launcher";

export const DEFAULT_SETTINGS: Settings = {
  downloadSource: "auto",
  connectionsPerFile: 4,
  concurrentDownloads: 12,
  curseforgeApiKey: "",
  modProvider: "modrinth",
  autoSwitchThresholdMs: 800,
  javaAutoDownload: true,
  javaAutoMatch: true,
  language: "zh-CN",
  closeToTray: true,
  showRelease: true,
  showSnapshot: true,
  showLegacy: true,
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
  // 与主进程默认一致：渐变默认开启（滑稽彩/欧皇彩在 theme.ts 里未指定两色时退化为纯色）
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
  brandTitle: "",
  brandSubtitle: "",
  appIcon: "",
  startupSound: "",
  startupVolume: 0.6,
  deeplApiKey: "mock:fx",
  natfrpToken: "",
  activeAccountId: "",
  microsoftClientId: "",
  microsoftClientIdManual: "",
};

/** 游戏目录（PCL2 风格布局）。 */
export const MOCK_GAME_ROOT = `${MOCK_ROOT}\\.minecraft`;
/** 启动器自身数据目录（配置/日志/缓存/Java）。 */
export const MOCK_DATA_ROOT = `${MOCK_ROOT}\\NaiWa`;

export const MOCK_APP_INFO: AppInfo = {
  nameEn: "NaiWa Launcher",
  nameZh: "奶娃启动器",
  developer: "奶龙",
  version: "0.1.5-mock",
  rootDir: MOCK_ROOT,
  gameRoot: MOCK_GAME_ROOT,
};

/**
 * 浏览器预览下 NaiWa 目录并不存在，file:// 指不到真实文件，
 * 因此额外给一张内联 SVG 当作「内置样例」背景，便于验证 .app-bg 与缩略图。
 */
export const MOCK_INLINE_BACKGROUND =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23283b6b'/%3E%3Cstop offset='1' stop-color='%23e0a93b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='360' fill='url(%23g)'/%3E%3C/svg%3E";

/** 顺序 / 随机轮播的第二张样例：青绿夜空 + 圆月。 */
export const MOCK_INLINE_BACKGROUND_2 =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='640' height='360' fill='%2312332c'/%3E%3Ccircle cx='470' cy='96' r='58' fill='%23f2e2b6'/%3E%3Crect y='250' width='640' height='110' fill='%231b4a3f'/%3E%3C/svg%3E";

/** 顺序 / 随机轮播的第三张样例：紫粉晚霞 + 地平线。 */
export const MOCK_INLINE_BACKGROUND_3 =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Cdefs%3E%3ClinearGradient id='s' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%233b1f57'/%3E%3Cstop offset='1' stop-color='%23e07a8b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='360' fill='url(%23s)'/%3E%3Crect y='300' width='640' height='60' fill='%232b1436'/%3E%3C/svg%3E";

/** 背景/音乐目录（契约新增的 media 面）在 mock 下的样例。 */
export const MOCK_MEDIA = {
  // 3 张内联 SVG 背景图：预览与轮播自检都不需要真实文件
  backgrounds: [MOCK_INLINE_BACKGROUND, MOCK_INLINE_BACKGROUND_2, MOCK_INLINE_BACKGROUND_3],
  music: ["sweden.mp3", "calm1.ogg", "wet-hands.flac"],
  icons: ["naiwa-256.png", "night-cat.ico"],
  dirs: {
    backgrounds: `${MOCK_DATA_ROOT}\\backgrounds`,
    music: `${MOCK_DATA_ROOT}\\music`,
    icons: `${MOCK_DATA_ROOT}\\icons`,
  },
};

/**
 * 自定义界面图标的样例：按文件名生成颜色不同的内联 SVG（data: URL），
 * 预览态没有真实的 NaiWa/icons 文件，自检据此断言「换图后 src 变了」。
 */
export function mockIconUrl(name: string): string {
  const hue = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const label = name.replace(/[<>&]/g, "").slice(0, 10);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>` +
    `<rect width='64' height='64' rx='14' fill='hsl(${hue} 62% 46%)'/>` +
    `<text x='32' y='42' font-size='26' text-anchor='middle' fill='#fff' font-family='sans-serif'>${label}</text>` +
    `</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/**
 * 启动音效的样例音频：1 秒 8kHz 8 位单声道静音 WAV（data: URL）。
 * 预览态没有真实的 resources/startup-bgm.mp3 可读，用它验证 src / volume / 试听。
 */
export const MOCK_STARTUP_SOUND: string = (() => {
  const rate = 8000;
  const samples = rate;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return "data:audio/wav;base64," + btoa(binary);
})();

export const MOCK_SOURCES: DownloadSourceInfo[] = [
  { id: "official", name: "官方源", description: "Mojang 官方 CDN，海外链路", baseUrl: "https://piston-meta.mojang.com", selectable: true },
  { id: "bmclapi", name: "BMCLAPI 镜像", description: "国内镜像，自动映射 libraries 与 assets", baseUrl: "https://bmclapi2.bangbang93.com", selectable: true },
  { id: "sjtu", name: "上海交大镜像", description: "仅镜像依赖库（libraries），本体与资源仍走主源", baseUrl: "https://mirror.sjtu.edu.cn/minecraft", selectable: true },
  { id: "auto", name: "自动测速", description: "启动前实测延迟，选更快的一侧", selectable: false },
];

const RAW_VERSIONS: Array<[string, VersionBrief["type"], string]> = [
  ["1.21.4", "release", "2024-12-03T10:12:57+00:00"],
  ["1.21.3", "release", "2024-10-23T08:19:06+00:00"],
  ["1.21.2", "release", "2024-10-22T09:04:53+00:00"],
  ["1.21.1", "release", "2024-08-08T14:22:11+00:00"],
  ["1.21", "release", "2024-06-13T08:07:59+00:00"],
  ["1.20.6", "release", "2024-04-29T12:03:17+00:00"],
  ["1.20.4", "release", "2023-12-07T12:56:32+00:00"],
  ["1.20.1", "release", "2023-06-12T12:23:44+00:00"],
  ["1.19.2", "release", "2022-08-05T11:57:13+00:00"],
  ["1.18.2", "release", "2022-02-28T10:39:49+00:00"],
  ["1.16.5", "release", "2021-01-14T16:05:32+00:00"],
  ["1.12.2", "release", "2017-09-18T08:39:46+00:00"],
  ["1.7.10", "release", "2014-05-14T15:29:23+00:00"],
  ["24w50a", "snapshot", "2024-12-11T13:29:11+00:00"],
  ["24w49a", "snapshot", "2024-12-04T12:17:04+00:00"],
  ["24w47a", "snapshot", "2024-11-20T12:49:41+00:00"],
  ["1.0.0", "old_beta", "2011-11-24T00:00:00+00:00"],
  ["a1.2.6", "old_alpha", "2010-12-02T00:00:00+00:00"],
];

export const MOCK_VERSIONS: VersionBrief[] = RAW_VERSIONS.map(([id, type, releaseTime]) => ({ id, type, releaseTime }));

export const MOCK_INSTANCES: InstanceMeta[] = [
  {
    id: "naiwa-create",
    name: "机械动力·创造",
    mcVersion: "1.20.1",
    loader: "fabric",
    loaderVersion: "0.16.9",
    versionId: "1.20.1-fabric",
    // 指向启动器已安装的 Liberica 17，演示「手动指定且有效」。
    javaPath: `${MOCK_DATA_ROOT}\\java\\17-17.0.13\\bin\\javaw.exe`,
    memoryMb: 6144,
    // 已统计：3.2 GB（卡片显示「占用：3.2 GB」）。
    diskUsageBytes: Math.round(3.2 * 1024 ** 3),
    extraJvmArgs: "-XX:+UseG1GC",
    windowMode: "windowed",
    windowSize: "1600x900",
    createdAt: Date.now() - 86400000 * 18,
    lastPlayedAt: Date.now() - 86400000 * 2,
  },
  {
    id: "naiwa-skyland",
    name: "悠然空岛",
    mcVersion: "1.21.4",
    loader: "vanilla",
    versionId: "1.21.4",
    memoryMb: 4096,
    // 已统计且不足 1 GB：卡片显示「占用：780 MB」，验证 MB 档位。
    diskUsageBytes: 780 * 1024 ** 2,
    extraJvmArgs: "",
    createdAt: Date.now() - 86400000 * 42,
    lastPlayedAt: Date.now() - 3600000 * 5,
  },
  {
    id: "naiwa-neo",
    name: "深岩之下",
    mcVersion: "1.21.1",
    loader: "neoforge",
    loaderVersion: "21.1.72",
    versionId: "1.21.1-neoforge",
    // 目录已被删除的 JDK，演示「已失效的路径」+ 一键清除。
    javaPath: `${MOCK_DATA_ROOT}\\java\\21-21.0.5\\bin\\javaw.exe`,
    memoryMb: 8192,
    // 故意不给 diskUsageBytes：验证「占用：计算中…」的缺省态。
    extraJvmArgs: "",
    createdAt: Date.now() - 86400000 * 6,
  },
];

/**
 * 每个实例的存档种子：只有「机械动力·创造」有存档，
 * 其中「生存基地」带 icon.png（内联 svg data URL），「创世测试」故意不带图标走占位色块。
 * 其余实例返回空数组，用于验证抽屉空态。
 */
export const MOCK_SAVES: Record<string, SaveInfo[]> = {
  "naiwa-create": [
    {
      folder: "生存基地",
      name: "生存基地",
      sizeBytes: 12_845_056,
      lastModified: Date.now() - 1000 * 60 * 42,
      iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiM1RjlCNEEiLz48cGF0aCBkPSJNMTQgNDRoMzZNMjAgNDRWMjJsMTItNiAxMiA2djIyIiBzdHJva2U9IiNGN0YzRTMiIHN0cm9rZS13aWR0aD0iNCIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHJlY3QgeD0iMjgiIHk9IjMyIiB3aWR0aD0iOCIgaGVpZ2h0PSIxMiIgZmlsbD0iI0Y3RjNFMyIvPjwvc3ZnPg==",
    },
    {
      folder: "创世测试",
      name: "创世测试",
      sizeBytes: 842_137,
      lastModified: Date.now() - 1000 * 60 * 60 * 26,
    },
  ],
};

export function mockLoaderVersions(mcVersion: string, loader: LoaderKind): LoaderVersionInfo[] {
  if (loader === "vanilla") return [];
  if (loader === "fabric") {
    return ["0.16.10", "0.16.9", "0.16.5", "0.15.11"].map((version, index) => ({
      loader, version, mcVersion, stable: index < 2,
    }));
  }
  if (loader === "forge") {
    return [`${mcVersion}-54.0.16`, `${mcVersion}-53.1.0`, `${mcVersion}-52.0.8`].map((version, index) => ({
      loader, version, mcVersion, stable: index < 2,
    }));
  }
  if (loader === "quilt") {
    return ["0.27.1", "0.27.0", "0.26.4", "0.25.0"].map((version, index) => ({
      loader, version, mcVersion, stable: index < 3,
    }));
  }
  if (loader === "liteloader") {
    // LiteLoader 只发布到 1.12.2；其它版本给空列表，界面上就是「该版本不支持」的提示。
    if (mcVersion !== "1.12.2") return [];
    return ["1.12.2", "1.12.2-SNAPSHOT-r1614"].map((version, index) => ({
      loader, version, mcVersion, stable: index === 0,
    }));
  }
  return ["21.4.111", "21.4.90", "21.3.56", "21.1.72"].map((version, index) => ({
    loader, version, mcVersion, stable: index < 3,
  }));
}

function javaRelease(major: number, version: string, lts: boolean, sizeBytes: number): JavaRelease {
  return {
    version,
    major,
    lts,
    downloadUrl: `https://download.bell-sw.com/java/${major}/bellsoft-jdk${version}+9-windows-amd64.zip`,
    fileName: `bellsoft-jdk${version}-windows-amd64.zip`,
    sizeBytes,
  };
}

export const MOCK_JAVA_RELEASES: JavaRelease[] = [
  javaRelease(25, "25.0.1", true, 198_000_000),
  javaRelease(21, "21.0.5", true, 191_000_000),
  javaRelease(21, "21.0.4", true, 190_400_000),
  javaRelease(17, "17.0.13", true, 188_000_000),
  javaRelease(17, "17.0.12", true, 187_500_000),
  javaRelease(11, "11.0.25", true, 182_000_000),
  javaRelease(11, "11.0.24", true, 181_400_000),
  javaRelease(8, "8.0.432", true, 176_000_000),
  javaRelease(8, "8.0.422", false, 175_000_000),
];

export const MOCK_INSTALLED_JAVA: InstalledJava[] = [
  { major: 8, version: "1.8.0_442", path: "C:\\Program Files\\Java\\jre1.8.0_442\\bin\\javaw.exe", vendor: "Oracle" },
  { major: 17, version: "17.0.13", path: `${MOCK_DATA_ROOT}\\java\\17-17.0.13\\bin\\javaw.exe`, vendor: "Liberica" },
];

function icon(letters: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${color}"/><text x="32" y="42" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="26" font-weight="700" fill="#16120E" text-anchor="middle">${letters}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 搜索结果样例：title/description 是来源站的原文（英文），
 * titleZh/summaryZh 模拟主进程实时翻译填充的译名；末两条故意不带译名，
 * 用来验证「没有译名时行为不变」的回退路径。
 * minekuai（麦块社区）条目的 projectId 就是 Modrinth 项目 ID，
 * 因此文件列表与安装沿用 Modrinth 那套 mock 分支。
 */
export const MOCK_MODS: ModSearchResult[] = [
  { provider: "modrinth", projectId: "AANobbMI", slug: "sodium", title: "Sodium", description: "Rewrites the terrain rendering pipeline: higher frame rates with the micro-stutter removed.", author: "jellysquid3", downloads: 48_230_000, iconUrl: icon("Na", "#F6D365"), categories: ["优化", "渲染"], titleZh: "钠", summaryZh: "重写渲染管线，帧率翻倍的同时修掉微卡顿。" },
  { provider: "modrinth", projectId: "YL57xq9U", slug: "iris", title: "Iris Shaders", description: "A high-performance shader loader compatible with OptiFine shader packs.", author: "IrisShaders", downloads: 21_400_000, iconUrl: icon("Ir", "#9BC53D"), categories: ["光影", "渲染"], titleZh: "虹膜光影", summaryZh: "兼容 OptiFine 光影包的高性能光影加载器。" },
  { provider: "modrinth", projectId: "lnW9H1E9", slug: "jei", title: "Just Enough Items", description: "Item and recipe lookup, a must-have for modpacks.", author: "mezz", downloads: 132_000_000, iconUrl: icon("JE", "#E0A93B"), categories: ["辅助", "查询"], titleZh: "物品管理器", summaryZh: "物品与合成表速查，模组整合包必备。" },
  { provider: "modrinth", projectId: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", description: "The core library of the Fabric ecosystem; required by most mods.", author: "FabricMC", downloads: 310_000_000, iconUrl: icon("FA", "#F5E8CE"), categories: ["前置"], titleZh: "Fabric 前置库", summaryZh: "Fabric 生态的基础库，绝大多数模组的前置。" },
  { provider: "modrinth", projectId: "LNytGWDc", slug: "create", title: "Create", description: "Build entire industrial assembly lines out of gears and shafts.", author: "simibubi", downloads: 36_800_000, iconUrl: icon("Cr", "#E0A93B"), categories: ["科技", "机械"], titleZh: "机械动力", summaryZh: "用齿轮与传动轴搭出整套工业流水线。" },
  { provider: "modrinth", projectId: "lfHFW1mp", slug: "journeymap", title: "JourneyMap", description: "Real-time minimap and full-screen world map with waypoints.", author: "techbrew", downloads: 74_100_000, iconUrl: icon("JM", "#9BC53D"), categories: ["地图", "辅助"], titleZh: "旅程地图", summaryZh: "实时小地图与全屏世界地图，支持路径点。" },
  { provider: "modrinth", projectId: "gvQqBUqZ", slug: "lithium", title: "Lithium", description: "Server and client performance optimizations that keep vanilla behavior intact.", author: "jellysquid3", downloads: 27_600_000, iconUrl: icon("Li", "#F6D365"), categories: ["优化"], titleZh: "锂", summaryZh: "不改变原版行为的服务端与客户端性能优化。" },
  { provider: "modrinth", projectId: "1bokaNcj", slug: "xaeros-minimap", title: "Xaero's Minimap", description: "A lightweight minimap that still runs smoothly on low-end machines.", author: "xaero96", downloads: 58_900_000, iconUrl: icon("Xa", "#9BC53D"), categories: ["地图"] },
  { provider: "curseforge", projectId: "260881", slug: "optifine", title: "OptiFine", description: "The classic visual and performance bundle, with shader and detail tuning.", author: "sp614x", downloads: 264_000_000, iconUrl: icon("OF", "#E0A93B"), categories: ["优化", "光影"], titleZh: "高清修复", summaryZh: "经典画质与性能整合，支持光影与细节调节。" },
  { provider: "curseforge", projectId: "74072", slug: "tinkers-construct", title: "Tinkers' Construct", description: "Forge your own tools and weapons with deep material combinations.", author: "SlimeKnights", downloads: 89_300_000, iconUrl: icon("Ti", "#F5E8CE"), categories: ["装备", "科技"], titleZh: "匠魂", summaryZh: "自己锻造工具与武器，材料组合自由度极高。" },
  { provider: "curseforge", projectId: "950086", slug: "farmers-delight", title: "Farmer's Delight", description: "Adds cooking systems and field crops, a great fit for cozy modpacks.", author: "vectorwing", downloads: 41_200_000, iconUrl: icon("FD", "#9BC53D"), categories: ["农业", "生活"], titleZh: "农夫乐事", summaryZh: "新增烹饪系统与田间作物，生活向整合好搭档。" },
  { provider: "curseforge", projectId: "639719", slug: "better-combat", title: "Better Combat", description: "Reworks the melee feel with smoother swings and combos.", author: "zsoltmolnarrr", downloads: 18_500_000, iconUrl: icon("BC", "#E0A93B"), categories: ["战斗"] },
  // 麦块社区：只提供中文译名与简介，title/description 是 Modrinth 原文，projectId 即 Modrinth ID。
  { provider: "minekuai", projectId: "mOgUt4GM", slug: "modmenu", title: "Mod Menu", description: "Browse and configure your installed mods from an in-game menu.", author: "Prospector", downloads: 62_400_000, iconUrl: icon("MM", "#9BC53D"), categories: ["辅助", "配置"], titleZh: "模组菜单", summaryZh: "在游戏内菜单里查看、排序与配置已安装的模组。" },
  { provider: "minekuai", projectId: "9s6osm5g", slug: "cloth-config", title: "Cloth Config API", description: "A config screen library shared by hundreds of mods.", author: "shedaniel", downloads: 108_000_000, iconUrl: icon("CC", "#F6D365"), categories: ["前置", "配置"], titleZh: "布料配置库", summaryZh: "数百个模组共用的图形化配置界面库。" },
  { provider: "minekuai", projectId: "lhGA9TYQ", slug: "architectury-api", title: "Architectury API", description: "An intermediary API that eases building multiplatform mods.", author: "shedaniel", downloads: 96_500_000, iconUrl: icon("Ar", "#E0A93B"), categories: ["前置"], titleZh: "建筑协同前置", summaryZh: "让同一份模组代码同时跑在 Fabric 与 NeoForge 上的中间层 API。" },
];

/**
 * 光影 / 资源包 / 整合包样例（麦块社区中文源）：
 * 与 MOCK_MODS 一致，title/description 是来源站原文，titleZh/summaryZh 模拟实时翻译。
 */
export const MOCK_SHADERS: ModSearchResult[] = [
  { provider: "minekuai", projectId: "shader-bsl", slug: "bsl-shaders", title: "BSL Shaders", description: "Soft lighting with configurable shadows, bloom and water waves.", author: "capttatsu", downloads: 12_400_000, iconUrl: icon("BS", "#8FB8F0"), categories: ["光影", "写实"], titleZh: "BSL 光影", summaryZh: "柔光配可调阴影与水面波纹，低配也能开的经典光影。" },
  { provider: "minekuai", projectId: "shader-complementary", slug: "complementary-shaders", title: "Complementary Shaders", description: "Two-in-one pack that ships ultra and lite profiles.", author: "EminGT", downloads: 9_860_000, iconUrl: icon("CS", "#9BC53D"), categories: ["光影", "综合"], titleZh: "补充光影", summaryZh: "把「超清」与「轻量」两套预设装进一个包，按机器切换。" },
];

export const MOCK_RESOURCEPACKS: ModSearchResult[] = [
  { provider: "minekuai", projectId: "rp-faithful", slug: "faithful-32x", title: "Faithful 32x", description: "Doubles vanilla texture resolution while keeping the original look.", author: "Faithful Team", downloads: 31_200_000, iconUrl: icon("F3", "#F5E8CE"), categories: ["材质", "原版增强", "32x"], titleZh: "忠实 32x", summaryZh: "把原版材质分辨率翻倍，画风和原版保持一致。" },
  { provider: "minekuai", projectId: "rp-stay-true", slug: "stay-true", title: "Stay True", description: "A cozy retexture that stays close to vanilla colors.", author: "TinyTinfoil", downloads: 8_400_000, iconUrl: icon("ST", "#9BC53D"), categories: ["材质", "清新", "16x"], titleZh: "原版温暖", summaryZh: "色彩柔和的原版风重绘，适合长期生存存档。" },
];

export const MOCK_MODPACKS: ModSearchResult[] = [
  { provider: "minekuai", projectId: "pack-skyland", slug: "naiwa-skyland-pack", title: "Floating Islands", description: "Skyblock progression pack with quests and shop economy.", author: "奶块整合组", downloads: 1_860_000, iconUrl: icon("FI", "#8FB8F0"), categories: ["空岛", "任务"], titleZh: "浮岛空岛", summaryZh: "带任务线与商店经济体系的空岛整合包。" },
  { provider: "minekuai", projectId: "pack-create-above", slug: "create-above-and-beyond", title: "Create: Above and Beyond", description: "Automation-focused pack built around Create technology.", author: "Create Team", downloads: 4_320_000, iconUrl: icon("CA", "#E0A93B"), categories: ["科技", "机械"], titleZh: "机械动力：星辰之上", summaryZh: "围绕机械动力搭起来的自动化整合包，教程齐全。" },
];

/** 按内容类型取搜索数据源；地图走 MOCK_MAPS，不在这里。 */
export const MOCK_CONTENT: Record<ModContentKind, ModSearchResult[]> = {
  mod: MOCK_MODS,
  shader: MOCK_SHADERS,
  resourcepack: MOCK_RESOURCEPACKS,
  modpack: MOCK_MODPACKS,
  map: [],
};

/**
 * 搜索结果的筛选用元数据：版本 / 加载器 / 分辨率 / 更新时间。
 * 真实链路由主进程按来源站返回，mock 单独存一份，筛选项也从它派生，保证每个选项都点得到内容。
 */
export interface MockContentMeta {
  versions?: string[];
  loaders?: string[];
  resolution?: string;
  updatedAt?: string;
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

export const MOCK_CONTENT_META: Record<string, MockContentMeta> = {
  AANobbMI: { versions: ["1.21.4", "1.21.1", "1.20.1"], loaders: ["fabric", "neoforge", "quilt"], updatedAt: daysAgo(3) },
  YL57xq9U: { versions: ["1.21.4", "1.20.1"], loaders: ["fabric", "neoforge"], updatedAt: daysAgo(6) },
  lnW9H1E9: { versions: ["1.21.1", "1.20.1", "1.19.2"], loaders: ["fabric", "forge"], updatedAt: daysAgo(12) },
  P7dR8mSH: { versions: ["1.21.4", "1.21.1", "1.20.1"], loaders: ["fabric", "quilt"], updatedAt: daysAgo(1) },
  LNytGWDc: { versions: ["1.20.1", "1.19.2"], loaders: ["forge", "neoforge", "fabric"], updatedAt: daysAgo(9) },
  lfHFW1mp: { versions: ["1.21.1", "1.20.1"], loaders: ["fabric", "forge"], updatedAt: daysAgo(21) },
  gvQqBUqZ: { versions: ["1.21.4", "1.20.1"], loaders: ["fabric", "neoforge"], updatedAt: daysAgo(5) },
  "1bokaNcj": { versions: ["1.21.4", "1.20.1", "1.19.2"], loaders: ["fabric", "forge"], updatedAt: daysAgo(40) },
  "260881": { versions: ["1.20.1", "1.19.2", "1.12.2"], loaders: ["forge"], updatedAt: daysAgo(60) },
  "74072": { versions: ["1.20.1", "1.19.2"], loaders: ["forge", "neoforge"], updatedAt: daysAgo(15) },
  "950086": { versions: ["1.21.1", "1.20.1"], loaders: ["fabric", "forge"], updatedAt: daysAgo(8) },
  "639719": { versions: ["1.21.1", "1.20.1"], loaders: ["fabric", "neoforge"], updatedAt: daysAgo(30) },
  mOgUt4GM: { versions: ["1.21.4", "1.21.1", "1.20.1"], loaders: ["fabric", "neoforge"], updatedAt: daysAgo(4) },
  "9s6osm5g": { versions: ["1.21.4", "1.20.1"], loaders: ["fabric", "forge"], updatedAt: daysAgo(11) },
  lhGA9TYQ: { versions: ["1.21.1", "1.20.1"], loaders: ["fabric", "forge", "neoforge"], updatedAt: daysAgo(18) },
  "shader-bsl": { versions: ["1.21.4", "1.20.1"], resolution: "标准", updatedAt: daysAgo(10) },
  "shader-complementary": { versions: ["1.21.1", "1.20.1"], resolution: "高清", updatedAt: daysAgo(14) },
  "rp-faithful": { versions: ["1.21.4", "1.20.1"], resolution: "32x", updatedAt: daysAgo(7) },
  "rp-stay-true": { versions: ["1.21.1", "1.20.1"], resolution: "16x", updatedAt: daysAgo(33) },
  "pack-skyland": { versions: ["1.20.1"], loaders: ["fabric"], updatedAt: daysAgo(2) },
  "pack-create-above": { versions: ["1.20.1", "1.19.2"], loaders: ["forge"], updatedAt: daysAgo(25) },
};

/** 文件列表与安装要能按 projectId 反查四类内容。 */
export function mockFindProject(projectId: string): ModSearchResult | undefined {
  return [...MOCK_MODS, ...MOCK_SHADERS, ...MOCK_RESOURCEPACKS, ...MOCK_MODPACKS]
    .find((project) => project.projectId === projectId);
}

/** 画廊占位图：16:9 渐变 + 标签文字的内联 SVG，预览与自检都不需要联网。 */
function galleryShot(label: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="480" height="270" fill="url(#g)"/><text x="24" y="240" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="24" font-weight="700" fill="#16120E">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 详情面板的版本/加载器标签样例：多于 10 个版本，用来验证「+N」折叠。 */
const DETAIL_VERSIONS = [
  "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.1",
  "1.19.2", "1.18.2", "1.16.5", "1.15.2", "1.14.4", "1.12.2",
];

/**
 * 麦块社区地图样例：2 条与默认实例（1.20.1）版本重叠、1 条只标 1.12.2（不适配）、
 * 1 条没有直链（需登录下载）。compatible 由 mock 的 maps 按实例版本计算，这里不写死。
 */
export const MOCK_MAPS: MapEntry[] = [
  { id: "map-skycity", title: "天空之城 · 空岛生存", description: "漂浮岛屿群组成的空岛生存地图，自带任务书、出生点商店与传送门。", versions: ["1.20.1", "1.21.4"], fileSize: 24_600_000, category: "生存", author: "奶块建筑组", coverUrl: galleryShot("天空之城", "#8FB8F0", "#1F68BC"), downloadUrl: "https://bbs.minekuai.com/resources/maps/skycity/download" },
  { id: "map-puzzle", title: "迷箱解谜 · 十二道机关", description: "十二个独立关卡的红石解谜地图，支持单人挑战与速通计时。", versions: ["1.20.1"], fileSize: 6_800_000, category: "解谜", author: "红石工坊", coverUrl: galleryShot("迷箱解谜", "#F6D365", "#E0A93B"), downloadUrl: "https://bbs.minekuai.com/resources/maps/puzzle/download" },
  { id: "map-legacy", title: "旧时光 · 1.12.2 怀旧跑酷", description: "为 1.12.2 打造的城市跑酷地图，用新版本打开会缺方块。", versions: ["1.12.2"], fileSize: 12_300_000, category: "跑酷", author: "Parkour老张", coverUrl: galleryShot("旧时光跑酷", "#9BC53D", "#4C7326"), downloadUrl: "https://bbs.minekuai.com/resources/maps/legacy/download" },
  { id: "map-login", title: "深海遗迹 · 探险地图", description: "海底遗迹探索与 BOSS 战，作者要求到网页登录后再下载完整包。", versions: ["1.20.1", "1.19.2"], fileSize: 38_900_000, category: "冒险", author: "深海工作室", coverUrl: galleryShot("深海遗迹", "#3E6E8C", "#12293B") },
];

function projectUrl(provider: ModSearchResult["provider"], slug: string): string {
  // 麦块社区的项目 id/slug 来自 Modrinth，主页也指向 Modrinth。
  return provider === "curseforge"
    ? `https://www.curseforge.com/minecraft/mc-mods/${slug}`
    : `https://modrinth.com/mod/${slug}`;
}

/** 未单独收录的项目按搜索卡片派生详情，保证任意卡片都能打开面板。 */
export function mockDetail(project: ModSearchResult): ModDetail {
  return {
    provider: project.provider,
    projectId: project.projectId,
    slug: project.slug,
    title: project.title,
    titleZh: project.titleZh,
    summary: project.description,
    body: `${project.title}\n\n${project.description}\n\n主要特性\n· 面向 Minecraft 1.21.x / 1.20.x 的稳定版本\n· 开箱即用，无需额外配置\n\n安装说明\n把文件交给启动器安装即可：模组落 mods、光影落 shaderpacks、资源包落 resourcepacks、整合包落 modpacks，重启游戏生效。`,
    author: project.author,
    downloads: project.downloads,
    followers: Math.round(project.downloads / 240),
    categories: project.categories,
    license: "MIT",
    sourceUrl: projectUrl(project.provider, project.slug),
    iconUrl: project.iconUrl,
    // 派生详情默认不带画廊：详情面板要能整块隐藏画廊区域。
    gallery: [],
    updatedAt: new Date(Date.now() - 86400000 * 6).toISOString(),
    gameVersions: DETAIL_VERSIONS,
    loaders: ["fabric", "forge", "neoforge", "quilt"],
    translated: false,
  };
}

/** 单独收录的详情样例：介绍更长，覆盖画廊多图与无画廊两种情况。 */
export const MOCK_MOD_DETAILS: Record<string, ModDetail> = {
  "modrinth:AANobbMI": {
    provider: "modrinth",
    projectId: "AANobbMI",
    slug: "sodium",
    title: "Sodium",
    titleZh: "钠",
    summary: "Rewrites the terrain rendering pipeline: higher frame rates with the micro-stutter removed.",
    body: [
      "Sodium 是面向 Fabric 的渲染优化模组，重写了区块渲染、光照与顶点管线。",
      "",
      "主要特性",
      "· 帧率通常提升 2–3 倍，显存占用明显下降",
      "· 消除区块加载与视角转动时的微卡顿",
      "· 与 Iris 光影共存，光影下同样有效",
      "",
      "兼容性说明",
      "Sodium 与 OptiFine 不兼容；与原版不同的渲染行为可能导致少数模组显示异常。",
      "这类文本按纯文本渲染，<b>标签不会被解析</b>，因此不存在脚本注入风险。",
    ].join("\n"),
    author: "jellysquid3",
    downloads: 48_230_000,
    followers: 186_400,
    categories: ["优化", "渲染"],
    license: "PolyForm Shield 1.0.0",
    sourceUrl: "https://modrinth.com/mod/sodium",
    iconUrl: icon("Na", "#F6D365"),
    gallery: [
      galleryShot("帧率对比", "#F6D365", "#E0A93B"),
      galleryShot("区块渲染", "#9BC53D", "#4C7326"),
      galleryShot("光影兼容", "#8FB8F0", "#1F68BC"),
    ],
    updatedAt: "2025-02-18T08:20:00+00:00",
    gameVersions: DETAIL_VERSIONS,
    loaders: ["fabric", "quilt"],
    translated: false,
  },
  "modrinth:LNytGWDc": {
    provider: "modrinth",
    projectId: "LNytGWDc",
    slug: "create",
    title: "Create",
    titleZh: "机械动力",
    summary: "Build entire industrial assembly lines out of gears and shafts.",
    body: "Create 把旋转动力、齿轮与传送带带进 Minecraft。\n\n上手顺序\n1. 放下动力源（水车 / 风车）\n2. 用传动轴把动力送到工作区\n3. 依次解锁压板、搅拌器与机械臂\n\n整合包作者可以在 config 里调整应力上限与产线速度。",
    author: "simibubi",
    downloads: 36_800_000,
    followers: 121_900,
    categories: ["科技", "机械"],
    license: "MIT",
    sourceUrl: "https://modrinth.com/mod/create",
    iconUrl: icon("Cr", "#E0A93B"),
    gallery: [
      galleryShot("传动系统", "#E0A93B", "#8B6416"),
      galleryShot("自动产线", "#9BC53D", "#4C7326"),
    ],
    updatedAt: "2025-01-09T12:41:00+00:00",
    gameVersions: ["1.21.1", "1.20.1", "1.19.2", "1.18.2", "1.16.5"],
    loaders: ["fabric", "forge", "neoforge"],
    translated: false,
  },
  "curseforge:260881": {
    provider: "curseforge",
    projectId: "260881",
    slug: "optifine",
    title: "OptiFine",
    titleZh: "高清修复",
    summary: "The classic visual and performance bundle, with shader and detail tuning.",
    body: "OptiFine 集成了画质与性能选项：\n\n· 光影与动态光源\n· 更细的区块与云雾设置\n· 帧率上限与快速渲染开关\n\n注意：与 Sodium 系优化模组不兼容。",
    author: "sp614x",
    downloads: 264_000_000,
    followers: 402_000,
    categories: ["优化", "光影"],
    license: "OptiFine License",
    sourceUrl: "https://www.curseforge.com/minecraft/mc-mods/optifine",
    iconUrl: icon("OF", "#E0A93B"),
    // 无画廊：详情面板应整块隐藏画廊区域。
    gallery: [],
    updatedAt: "2024-11-30T03:12:00+00:00",
    gameVersions: ["1.21.4", "1.21.1", "1.20.6", "1.20.1", "1.19.2"],
    loaders: ["forge"],
    translated: false,
  },
};

/** 详情取数：优先用收录的样例，其余按卡片派生。 */
export function mockDetailFor(project: ModSearchResult): ModDetail {
  return MOCK_MOD_DETAILS[`${project.provider}:${project.projectId}`] ?? mockDetail(project);
}

/** 实例 mods 目录的预置文件；样例保证「3 个模组、1 个有更新」。 */
export const MOCK_INSTALLED_MODS: Record<string, InstalledModInfo[]> = {
  "naiwa-create": [
    {
      fileName: "sodium-fabric-0.5.11+mc1.20.1.jar",
      sizeBytes: 1_284_096,
      sha1: "5f2a9c3d7e1b48a06c9d2f5b8e4a1c7d3b6f9e2a",
      modId: "sodium",
      name: "Sodium 钠",
      version: "0.5.11",
      provider: "modrinth",
      projectId: "AANobbMI",
      update: null,
    },
    {
      fileName: "fabric-api-0.92.2+1.20.1.jar",
      sizeBytes: 2_106_368,
      sha1: "b71c04d9a6e2f83c5b0d7a1e9f4c2b8d6a3e5f10",
      modId: "fabric-api",
      name: "Fabric API",
      version: "0.92.2",
      provider: "modrinth",
      projectId: "P7dR8mSH",
      update: null,
    },
    {
      fileName: "create-1.20.1-0.5.1.f.jar",
      sizeBytes: 14_802_944,
      sha1: "3ad9f6b2c81e04d7a5f3b9c2e6d8a1f4c7b0e9d3",
      modId: "create",
      name: "Create 机械动力",
      version: "0.5.1.f",
      provider: "modrinth",
      projectId: "LNytGWDc",
      update: null,
    },
  ],
  "naiwa-neo": [
    {
      fileName: "jei-1.21.1-neoforge-19.21.0.247.jar",
      sizeBytes: 1_486_848,
      sha1: "8c4e1f7a3d9b6250c8a4e7f1b3d5c9a2e6f8b0d4",
      modId: "jei",
      name: "Just Enough Items",
      version: "19.21.0.247",
      provider: "modrinth",
      projectId: "lnW9H1E9",
      update: null,
    },
    {
      fileName: "journeymap-1.21.1-6.0.0-beta.31.jar",
      sizeBytes: 5_242_880,
      sha1: "d2b8a5e9c1f70463a9d2e5b8c1f4a7d0e3b6c9f2",
      modId: "journeymap",
      name: "JourneyMap 旅程地图",
      version: "6.0.0-beta.31",
      provider: "modrinth",
      projectId: "lfHFW1mp",
      update: null,
    },
  ],
};

/**
 * 前置依赖样例（按 `provider:projectId` 索引）。
 * installed / installedFileName 不写死：mock 按实例 mods 目录的现状推断，装完前置后会自动变成已安装。
 */
export const MOCK_MOD_DEPENDENCIES: Record<string, Array<Omit<ModDependency, "installed" | "installedFileName">>> = {
  // 钠：Fabric API 在 naiwa-create 里已装（已安装），Cloth Config 没装（将一并安装）。
  "modrinth:AANobbMI": [
    { provider: "modrinth", projectId: "P7dR8mSH", name: "Fabric API", nameZh: "Fabric 前置库", slug: "fabric-api", required: true },
    { provider: "modrinth", projectId: "9s6osm5g", name: "Cloth Config API", nameZh: "布料配置库", slug: "cloth-config", required: true },
  ],
  // 虹膜光影：钠已装，Indium 没装。
  "modrinth:YL57xq9U": [
    { provider: "modrinth", projectId: "AANobbMI", name: "Sodium", nameZh: "钠", slug: "sodium", required: true },
    { provider: "modrinth", projectId: "GmjmRQ0A", name: "Indium", nameZh: "铟", slug: "indium", required: true },
  ],
  // 物品管理器：无前置（确认「无需弹框，直接安装」）。
  "modrinth:lnW9H1E9": [],
};

/** 连带安装的前置 jar 文件名：沿用 mockFiles 的 `slug-版本-加载器-序号.jar` 命名。 */
export function mockDependencyFile(slug: string): string {
  return `${slug}-1.20.1-fabric-1.jar`;
}

/** checkUpdates 反查到的远端目标文件：只有 sodium 一条，用于演示「可更新」高亮。 */
export const MOCK_MOD_UPDATES: Record<string, NonNullable<InstalledModInfo["update"]>> = {
  "sodium-fabric-0.5.11+mc1.20.1.jar": {
    provider: "modrinth",
    projectId: "AANobbMI",
    fileId: "u-AANobbMI-0.6.9",
    fileName: "sodium-fabric-0.6.9+mc1.20.1.jar",
    versionLabel: "0.6.9",
  },
};

/** 各内容类型的文件扩展名：光影/资源包是 zip，整合包是 mrpack。 */
const KIND_FILE_EXT: Record<ModContentKind, string> = {
  mod: "jar",
  shader: "zip",
  resourcepack: "zip",
  modpack: "mrpack",
  map: "zip",
};

/** 依据目标版本与加载器生成一组可用文件，保证有精确匹配与不完全匹配。 */
export function mockFiles(
  project: ModSearchResult, gameVersion: string, loader: string, kind: ModContentKind = "mod",
): ModFileInfo[] {
  const base = gameVersion || "1.21.4";
  const versions = [base, base, "1.21.1", "1.20.1", "1.20.1", "1.19.2"];
  const loaders = [loader || "fabric", loader || "fabric", "fabric", "forge", "fabric", "forge"];
  const types: Array<"release" | "beta" | "alpha"> = ["release", "beta", "release", "release", "beta", "release"];
  return versions.map((version, index) => {
    const fileId = String(1000 + index);
    const fileName = `${project.slug}-${version}-${loaders[index]}-${index + 1}.${KIND_FILE_EXT[kind]}`;
    return {
      provider: project.provider,
      fileId,
      name: `${project.title} ${version} (${index === 0 ? "最新" : "#" + (index + 1)})`,
      fileName,
      downloadUrl: `https://example.invalid/mods/${project.slug}/${fileName}`,
      gameVersions: [version],
      loaders: [loaders[index]],
      exactMatch: version === gameVersion && loaders[index] === loader,
      releaseType: types[index],
      downloads: Math.round(project.downloads / (index + 2)),
      publishedAt: new Date(Date.now() - (index + 1) * 86400000 * 9).toISOString(),
    };
  });
}

/** 账号种子：3 个（2 离线 + 1 微软），覆盖两种徽标与微软令牌字段。 */
export const MOCK_ACCOUNTS: Account[] = [
  {
    id: "acc-offline-1",
    type: "offline",
    name: "NaiWa",
    uuid: "8f3c1d5a7b9e2044c6a8d0f2b4e68c1a",
    createdAt: Date.UTC(2024, 8, 12, 9, 30),
    lastUsedAt: Date.UTC(2024, 10, 3, 20, 12),
  },
  {
    id: "acc-ms-1",
    type: "microsoft",
    name: "DragonRider",
    uuid: "3b7e9a1c5d2f8046b1c3e5a7d9f20b48",
    createdAt: Date.UTC(2024, 6, 1, 14, 5),
    lastUsedAt: Date.UTC(2024, 9, 28, 19, 40),
    microsoft: {
      refreshToken: "mock-refresh-token",
      accessToken: "mock-access-token",
      expiresAt: Date.UTC(2024, 10, 30, 12, 0),
      xuid: "2535412345678901",
    },
  },
  {
    id: "acc-offline-2",
    type: "offline",
    name: "LittleDragon",
    uuid: "c4d18a6f2b03e7951a8c4d6f0b2e3958",
    createdAt: Date.UTC(2024, 9, 20, 16, 48),
    lastUsedAt: Date.UTC(2024, 9, 22, 21, 3),
  },
];