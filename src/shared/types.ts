// Domain types shared by main, preload and renderer. No Node or Electron imports here.

export type DownloadSourceId = "official" | "bmclapi" | "sjtu" | "auto";

export interface DownloadSourceInfo {
  id: DownloadSourceId;
  name: string;
  description: string;
  /** Base url used for Minecraft metadata/assets, without trailing slash. */
  baseUrl?: string;
  /** Whether this entry is a concrete runtime source (auto is a selector, not a source). */
  selectable: boolean;
}

export type LoaderKind = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge" | "liteloader";

export type ModProviderId = "modrinth" | "curseforge" | "minekuai";

export type ThemeId =
  | "dragon"     // 龙猫蓝
  | "lemon"      // 甜柠青
  | "grass"      // 小草绿
  | "pineapple"  // 菠萝黄
  | "oak"        // 橡木棕
  | "midnight"   // 玄素黑
  | "candy"      // 滑稽彩
  | "pink"       // 铁杆粉
  | "mystery"    // 神秘紫
  | "lucky"      // 欧皇彩
  | "autumn"     // 秋仪金
  | "orange"     // 活泼橙
  | "red"        // 跳票红
  | "geek"       // 极客蓝
  | "custom";    // 自定义

export type TitleBarStyle = "compact" | "image";
export type BackgroundMode = "single" | "sequence" | "random";
export type VersionListSource = "official" | "bmclapi" | "auto";
export type ModDisplayStyle = "title" | "filename";
export type VersionIsolation = "all" | "none";
export type LauncherVisibility = "keep" | "minimize" | "close";
export type ProcessPriority = "low" | "normal" | "high";
/** 游戏窗口形态：inherit 跟随全局「启动」设置；windowed 窗口；fullscreen 全屏。 */
export type WindowMode = "inherit" | "windowed" | "fullscreen";

export interface MediaList {
  backgrounds: string[];
  music: string[];
  /** NaiWa/icons 下可用于替换界面图标的图片。 */
  icons: string[];
  dirs: { backgrounds: string; music: string; icons: string };
}

export interface Settings {
  downloadSource: DownloadSourceId;
  /** Concurrent chunk connections per file. 1..16 */
  connectionsPerFile: number;
  /** Concurrent file downloads. 1..32 */
  concurrentDownloads: number;
  curseforgeApiKey: string;
  modProvider: ModProviderId;
  /** Fall back to the mirror when the official source is slower than this many ms. */
  autoSwitchThresholdMs: number;
  javaAutoDownload: boolean;
  /** 按 Minecraft 版本自动匹配 JDK；关闭后只使用实例上指定的 Java。 */
  javaAutoMatch: boolean;
  language: "zh-CN" | "en-US";
  closeToTray: boolean;
  /** 版本列表过滤器：正式版 / 测试版（快照）/ 远古版（old_beta + old_alpha），默认全开。 */
  showRelease: boolean;
  showSnapshot: boolean;
  showLegacy: boolean;
  /** 个性化：主题与外观 */
  theme: ThemeId;
  /** 自定义主题色（theme === "custom" 时生效），形如 #F6D365。 */
  accentColor: string;
  /** 界面不透明度 0.6–1。 */
  uiOpacity: number;
  /** 启动时是否播放 logo 渐显动画。 */
  showSplash: boolean;
  /** 背景图片文件名（NaiWa/backgrounds 下），空串表示不使用。 */
  backgroundImage: string;
  /** 背景音乐文件名（NaiWa/music 下），空串表示不播放。 */
  backgroundMusic: string;
  /** 背景音乐音量 0–1。 */
  musicVolume: number;
  /** 标题栏样式：精简（自绘拖拽条）/ 图片（自绘 + 背景图）。系统标题栏已移除。 */
  titleBar: TitleBarStyle;
  /** 标题栏自定义文字；空串用默认「奶娃启动器 NaiWa Launcher」。 */
  titleBarText: string;
  /** 背景图播放方式：单张 / 顺序轮播 / 随机轮播。 */
  backgroundMode: BackgroundMode;
  /** 轮播间隔（秒）。 */
  backgroundIntervalSec: number;
  /** 是否使用渐变配色（对所有主题生效；关闭时用纯色）。 */
  customGradient: boolean;
  /** 渐变起始色（空串表示跟随主题主色）。 */
  gradientFrom: string;
  /** 渐变结束色（空串表示由主色推导）。 */
  gradientTo: string;
  /** 版本清单来源（可与文件下载源不同）。 */
  versionListSource: VersionListSource;
  /** 全局下载限速（KB/s），0 表示不限速。 */
  speedLimitKbps: number;
  /** 模组文件名模板，可用占位符 {name} {slug} {version} {loader} {mc}。 */
  modFileNameTemplate: string;
  /** 模组列表显示风格：标题优先或文件名优先。 */
  modDisplayStyle: ModDisplayStyle;
  /** 游戏本体有新版本时在启动器内提示。 */
  notifyGameUpdates: boolean;
  /** 启动前强制把游戏语言设为简体中文（即使玩家改过）。 */
  forceChinese: boolean;
  /** 版本隔离：all = 每个实例独立游戏目录；none = 共用 .minecraft。 */
  versionIsolation: VersionIsolation;
  /** 游戏窗口标题，空串表示使用默认（实例名）。 */
  windowTitle: string;
  /** 启动器标识，写入 -Dminecraft.launcher.brand。 */
  launcherBrand: string;
  /** 游戏启动后启动器窗口行为。 */
  launcherVisibility: LauncherVisibility;
  /** 游戏进程优先级。 */
  processPriority: ProcessPriority;
  /** 游戏窗口大小："default" 或 "宽x高"，例如 "1280x720"。 */
  windowSize: string;
  /** 模组列表实时翻译（标题/简介译为简体中文）。 */
  translateMods: boolean;
  /** 中文搜索：查询含中文时先译为英文再检索。 */
  translateSearch: boolean;
  /** 侧边栏品牌主标题（空串 = 默认「NaiWa」）。 */
  brandTitle: string;
  /** 侧边栏品牌副标题（空串 = 默认「奶娃启动器」）。 */
  brandSubtitle: string;
  /** 自定义界面图标："" = 内置 logo；其它为 NaiWa/icons 下的文件名。 */
  appIcon: string;
  /** 启动音效："" = 内置默认；"off" = 关闭；其它为 NaiWa/music 下的文件名。 */
  startupSound: string;
  /** 启动音效音量 0–1。 */
  startupVolume: number;
  /** DeepL API Key（:fx 结尾为免费版端点）；为空则回退到 uapis/suapi。 */
  deeplApiKey: string;
  /** 樱花穿透访问密钥（natfrp.com 的 Access Token），空串表示未配置。 */
  natfrpToken: string;
  /** 当前使用的账号 id，空串表示未选择。 */
  activeAccountId: string;
  /** 生效的 Azure 应用 client id（= 手动填写 || 内置）。 */
  microsoftClientId: string;
  /** 用户手动填写的 client id；为空表示使用内置公共 id。 */
  microsoftClientIdManual: string;
}

export interface InstanceMeta {
  id: string;
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  /** Version id inside <root>/versions that actually gets launched (e.g. "1.21.4-fabric"). */
  versionId: string;
  javaPath?: string;
  memoryMb: number;
  extraJvmArgs: string;
  createdAt: number;
  lastPlayedAt?: number;
  icon?: string;
  /** 窗口形态；旧实例没有这个字段，等同 inherit（跟随全局设置）。 */
  windowMode?: WindowMode;
  /** 窗口尺寸："inherit" 跟随全局、"default" 原版默认、或 "宽x高"（如 "1280x720"）；缺省等同 inherit。 */
  windowSize?: string;
  /** 实例目录占用的本地空间（字节，懒计算并缓存；尚未统计时缺省）。 */
  diskUsageBytes?: number;
}

/** 实例里的一个单人存档。 */
/** 樱花穿透账号信息。 */
export interface NatfrpUser {
  id: number;
  name: string;
  email?: string;
  /** 剩余流量（字节），来自 /user/info 的 traffic[1]。 */
  trafficLeft?: number | null;
  /** 本日已消耗流量（字节），traffic[0]。 */
  trafficToday?: number | null;
  groupName?: string;
  /** 今日是否已签到（只读展示，启动器不做签到）。 */
  signed?: boolean;
  /** 连续签到天数（只读展示）。 */
  signDays?: number;
}

/** 樱花穿透隧道。 */
export interface NatfrpTunnel {
  id: number;
  name: string;
  type: string;
  node: number;
  nodeName?: string;
  localIp: string;
  localPort: number;
  /** 公网访问地址（如 "cn-1.frp.one:12345"），未知时为空。 */
  remote?: string;
  online: boolean;
}

/** 樱花穿透运行状态（frpc 进程）。 */
export interface NatfrpStatus {
  running: boolean;
  /** 正在运行的隧道 id。 */
  tunnelId?: number;
  /** frpc 输出的公网地址。 */
  address?: string;
  /** 最近若干行日志。 */
  log: string[];
  /** frpc 可执行文件是否已就绪。 */
  frpcReady: boolean;
}

/** 实例导出/导入结果。 */
export interface InstanceExportResult {
  /** 用户取消时为 null。 */
  path: string | null;
  /** 打包进压缩包的实例名。 */
  name: string;
  /** 体积（字节）。 */
  sizeBytes: number;
}

export interface InstanceImportResult {
  /** 用户取消时为 null。 */
  instanceId: string | null;
  name: string;
  /** 导入时是否需要补装原版/加载器。 */
  installedMissing?: boolean;
}

/** 本机可用于联机的局域网地址。 */
export interface LanAddress {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
}

export interface PortProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface SaveInfo {
  /** saves/ 下的文件夹名（也是 quickPlay 的 level id）。 */
  folder: string;
  /** 展示名（读不到 level.dat 时用文件夹名）。 */
  name: string;
  sizeBytes: number;
  lastModified: number;
  /** icon.png 的 file:// URL（没有则为空）。 */
  iconUrl?: string;
}

export interface VersionBrief {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface LoaderVersionInfo {
  loader: LoaderKind;
  version: string;
  mcVersion: string;
  stable: boolean;
}

export interface JavaRelease {
  /** Vendor version string, e.g. "21.0.5". */
  version: string;
  major: number;
  lts: boolean;
  downloadUrl: string;
  fileName: string;
  sizeBytes?: number;
}

export interface InstalledJava {
  major: number;
  version: string;
  path: string;
  vendor: string;
}

export interface ModSearchResult {
  provider: ModProviderId;
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl?: string;
  categories: string[];
  /** 中文译名（实时翻译，可为空）。 */
  titleZh?: string;
  /** 中文简介（实时翻译，可为空）。 */
  summaryZh?: string;
  /** 最近更新时间（ISO 字符串，卡片上的相对时间）。 */
  updatedAt?: string;
}

/** 资源来源：具体站点或「所有来源」。 */
export type ModSourceFilter = ModProviderId | "all";

/** 软件更新检查结果（与 GitHub 仓库版本挂钩）。 */
export interface UpdateCheckResult {
  /** 当前版本。 */
  current: string;
  /** 仓库里的最新版本（拿不到为 null）。 */
  latest: string | null;
  hasUpdate: boolean;
  /** 发布页/下载页地址。 */
  url?: string;
  /** 发布说明（截断）。 */
  notes?: string;
  publishedAt?: string;
  /** 免安装版更新包的直链（Release 里的 NaiWaLauncher.exe）。 */
  assetUrl?: string;
  /** 实际取数的通道（便于排查）。 */
  channel: "github-api" | "gh-proxy" | "jsdelivr" | "sakuramoe" | "raw" | "none";
  /** 检查失败时的原因。 */
  error?: string;
}

/** 资源分类。 */
export interface ModCategory {
  id: string;
  name: string;
  /** 该分类下的资源数（拿不到时省略）。 */
  count?: number;
  /** 分类图标名（可选，UI 自行映射）。 */
  icon?: string;
}

/** 资源筛选项。 */
export interface ModFilterOptions {
  versions: string[];
  loaders: string[];
  resolutions: string[];
}

/** 下载/安装任务记录（持久化，重启后可继续）。 */
export interface DownloadJob {
  id: string;
  /** 任务类型：安装游戏版本 / 安装加载器 / 安装 Java / 下载模组。 */
  kind: "version" | "loader" | "java" | "content";
  title: string;
  /** 目标描述（版本号、实例名等）。 */
  detail: string;
  /** cancelled：用户主动终止（传输已中断，半成品保留，可继续）。 */
  status: "running" | "paused" | "interrupted" | "cancelled" | "done" | "failed";
  /** 0-100。 */
  progress: number;
  message?: string;
  createdAt: number;
  updatedAt: number;
  /** 恢复该任务所需的参数（内部使用，UI 不必展示）。 */
  resume?: string;
}

/** 内容类型：模组 / 光影 / 资源包 / 整合包 / 地图。 */
export type ModContentKind = "mod" | "shader" | "resourcepack" | "modpack" | "map";

/** 麦块社区的社区地图（列表公开，下载需登录）。 */
export interface MapEntry {
  id: string;
  title: string;
  description: string;
  /** 适配的游戏版本，如 ["1.19.3"]；可能带 v 前缀。 */
  versions: string[];
  fileSize: number;
  category: string;
  author: string;
  coverUrl?: string;
  /** 直链；为空表示需要登录麦块后到网页下载。 */
  downloadUrl?: string;
  /** 与当前实例的游戏版本是否兼容（由主进程按实例计算）。 */
  compatible?: boolean;
}

/** 模组前置依赖（安装前检查用）。 */
export interface ModDependency {
  provider: ModProviderId;
  /** 依赖的项目 id（Modrinth project_id / CurseForge modId）。 */
  projectId: string;
  /** 依赖方给出的版本 id（可能为空，表示取最优匹配）。 */
  versionId?: string;
  /** 能拿到名字时填充（中文名可能为空）。 */
  name?: string;
  nameZh?: string;
  slug?: string;
  /** 是否必需（optional 的不算）。 */
  required: boolean;
  /** 当前实例里是否已经装了。 */
  installed: boolean;
  /** 已安装时的文件名，便于界面提示。 */
  installedFileName?: string;
}

/** 模组详情（点击模组后展示）。 */
export interface ModDetail {
  provider: ModProviderId;
  projectId: string;
  slug: string;
  title: string;
  /** 中文名（若镜像/翻译源提供）。 */
  titleZh?: string;
  summary: string;
  /** 摘要的中文译文（实时翻译，可为空）。 */
  summaryZh?: string;
  /** 完整介绍（Markdown 原文）。 */
  body: string;
  bodyZh?: string;
  author: string;
  downloads: number;
  followers?: number;
  categories: string[];
  license?: string;
  sourceUrl?: string;
  iconUrl?: string;
  gallery: string[];
  updatedAt?: string;
  /** 展示用的游戏版本/加载器范围。 */
  gameVersions: string[];
  loaders: string[];
  /** 是否由翻译/镜像补全了中文。 */
  translated: boolean;
}

export interface ModFileInfo {
  provider: ModProviderId;
  fileId: string;
  name: string;
  fileName: string;
  downloadUrl: string;
  gameVersions: string[];
  loaders: string[];
  /** True when the file matches the target instance version + loader exactly. */
  exactMatch: boolean;
  releaseType: "release" | "beta" | "alpha";
  downloads: number;
  publishedAt: string;
}

export type AccountType = "offline" | "microsoft" | "yggdrasil";

export interface Account {
  id: string;
  type: AccountType;
  /** 游戏内显示的名字（微软账号为 Minecraft 档案名）。 */
  name: string;
  /** 无横线的 32 位 UUID。 */
  uuid: string;
  createdAt: number;
  lastUsedAt?: number;
  /** 第三方（Yggdrasil / authlib-injector）账号信息。 */
  yggdrasil?: {
    /** API 根地址，例如 https://littleskin.cn/api/yggdrasil */
    apiUrl: string;
    accessToken: string;
    clientToken: string;
    /** 令牌到期时间戳（毫秒），0 表示不失效。 */
    expiresAt: number;
    /** 该服务商的皮肤站主页（未知时不填）。 */
    siteName?: string;
    /** 该账号在服务端的全部角色（登录时保存，用于角色切换）。 */
    profiles?: { id: string; name: string }[];
  };
  /** 微软账号令牌（离线账号没有）。 */
  microsoft?: {
    refreshToken: string;
    accessToken: string;
    /** accessToken 到期时间戳（毫秒）。 */
    expiresAt: number;
    xuid?: string;
  };
}

/** 本地衣柜里的一张皮肤。 */
export interface WardrobeSkin {
  /** 文件名（NaiWa/skins 下）。 */
  name: string;
  /** file:// 直链，可直接给 <img>。 */
  url: string;
  sizeBytes: number;
  updatedAt: number;
}

/** 第三方账号可用的角色。 */
export interface SkinProfile {
  id: string;
  name: string;
  /** 是否为当前使用中的角色。 */
  active: boolean;
}

/** 账号皮肤信息。 */
export interface SkinInfo {
  /** 用哪种接口拿到的：yggdrasil / mojang / none。 */
  source: "yggdrasil" | "mojang" | "none";
  /** 当前皮肤直链（可为空）。 */
  skinUrl?: string;
  /** 披风直链（可为空）。 */
  capeUrl?: string;
  /** 皮肤模型：classic（Steve）或 slim（Alex）。 */
  model?: "classic" | "slim";
  /** 是否支持上传/更换皮肤。 */
  canUpload: boolean;
  /** 不支持或失败的原因。 */
  error?: string;
}

/** 微软设备码登录的挑战信息，交给界面展示。 */
export interface DeviceCodeChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type MicrosoftLoginState =
  | { status: "pending" }
  | { status: "ok"; account: Account }
  | { status: "error"; message: string };

export interface InstalledModInfo {
  fileName: string;
  sizeBytes: number;
  /** 文件 sha1，用于向 Modrinth/CurseForge 反查所属项目与版本。 */
  sha1: string;
  modId?: string;
  name?: string;
  version?: string;
  provider?: ModProviderId;
  projectId?: string;
  /** 有可用更新时的目标文件（仅 checkUpdates 填充）。 */
  update?: {
    provider: ModProviderId;
    projectId: string;
    fileId: string;
    fileName: string;
    versionLabel: string;
  } | null;
}

export type TaskKind = "game" | "libraries" | "assets" | "loader" | "java" | "mod" | "generic";

export interface TaskProgress {
  taskId: string;
  kind: TaskKind;
  label: string;
  stage: string;
  /** 0..1, or null when total size is unknown. */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  filesDone: number;
  filesTotal: number;
  /** Per-file progress for the active connections. */
  connections?: number;
}

export interface TaskResult {
  taskId: string;
  kind: TaskKind;
  label: string;
  ok: boolean;
  error?: string;
  /** Free-form artifact of the task, e.g. installed version id. */
  data?: unknown;
}

export interface SourceProbe {
  sourceId: DownloadSourceId;
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface AppInfo {
  nameEn: string;
  nameZh: string;
  developer: string;
  version: string;
  /** 启动器根目录（exe 同级）。 */
  rootDir: string;
  /** Minecraft 游戏目录 <root>/.minecraft。 */
  gameRoot: string;
}

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  time: number;
}
