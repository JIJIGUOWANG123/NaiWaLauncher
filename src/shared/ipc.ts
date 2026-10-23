import type {
  Account, AppInfo, DeviceCodeChallenge, DownloadSourceId, DownloadSourceInfo, InstanceMeta, InstalledJava,
  ChangelogSection, DownloadJob, InstalledModInfo, InstalledContentRef, LocalCape, LocalSkin, LocalSkinSelection, SkinApplyResult, ServerBuildInfo, ServerConsoleLine, ServerCoreId, ServerCoreInfo, ServerEntry, ServerMeta, JavaRelease, LanAddress, MapEntry, NatfrpStatus, NatfrpTunnel, NatfrpUser, ModContentKind, MediaList, MicrosoftLoginState, ModDependency,
  PortProbeResult, SaveInfo, UpdateCheckResult, InstanceExportResult, InstanceImportResult,
  LoaderKind, LoaderVersionInfo, LogLine, ModCategory, ModFileInfo, ModFilterOptions, ModProviderId,
  ApiBackground, JavaSourceId, JavaSourceProbe, WallpaperEntry,
  ModSearchResult, ModSourceFilter, Settings, SkinInfo, SkinProfile, ModDetail, SourceProbe, TaskProgress, TaskResult, VersionBrief,
  WardrobeSkin,
} from "./types";

export type { ModSourceFilter } from "./types";

export const IPC = {
  appInfo: "app:info",
  openPath: "app:openPath",
  copyText: "app:copyText",
  pathExists: "app:pathExists",
  startupSound: "app:startupSound",
  appIcon: "app:appIcon",
  appCheckUpdates: "app:checkUpdates",
  appInstallUpdate: "app:installUpdate",
  appReveal: "app:reveal",
  appChangelog: "app:changelog",
  downloadsList: "downloads:list",
  downloadsResume: "downloads:resume",
  downloadsCancel: "downloads:cancel",
  downloadsRemove: "downloads:remove",
  downloadsClearFinished: "downloads:clearFinished",
  downloadsChanged: "downloads:changed",
  netInterfaces: "net:interfaces",
  netProbe: "net:probe",
  netPortCheck: "net:portCheck",
  natfrpUser: "net:natfrpUser",
  natfrpTunnels: "net:natfrpTunnels",
  natfrpCreate: "net:natfrpCreate",
  natfrpStatus: "net:natfrpStatus",
  natfrpStart: "net:natfrpStart",
  natfrpStop: "net:natfrpStop",
  natfrpNodes: "net:natfrpNodes",
  openInstanceMods: "app:openInstanceMods",
  openInstanceContent: "app:openInstanceContent",
  openRootDir: "app:openRootDir",
  log: "app:log",

  mediaList: "media:list",
  wallpaperList: "wallpaper:list",
  mediaApiBackground: "media:apiBackground",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggleMaximize",
  windowClose: "window:close",
  windowIsMaximized: "window:isMaximized",

  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  openExternal: "app:openExternal",

  sourcesList: "sources:list",
  sourcesProbe: "sources:probe",
  sourcesSet: "sources:set",

  accountsList: "accounts:list",
  accountsCreateOffline: "accounts:createOffline",
  accountsRemove: "accounts:remove",
  accountsSetActive: "accounts:setActive",
  accountsLoginYggdrasil: "accounts:loginYggdrasil",
  accountsValidateYggdrasil: "accounts:validateYggdrasil",
  skinsGet: "skins:get",
  skinsUpload: "skins:upload",
  skinsReset: "skins:reset",
  skinsPickFile: "skins:pickFile",
  skinsWardrobe: "skins:wardrobe",
  skinsAddToWardrobe: "skins:addToWardrobe",
  skinsRemoveFromWardrobe: "skins:removeFromWardrobe",
  skinsProfiles: "skins:profiles",
  skinsSelectProfile: "skins:selectProfile",
  accountsBeginMicrosoft: "accounts:beginMicrosoft",
  accountsPollMicrosoft: "accounts:pollMicrosoft",

  versionsList: "versions:list",
  versionsRefresh: "versions:refresh",

  loadersList: "loaders:list",

  instancesList: "instances:list",
  instancesCreate: "instances:create",
  instancesUpdate: "instances:update",
  instancesDelete: "instances:delete",
  instancesLaunch: "instances:launch",
  instancesSaves: "instances:saves",
  instancesExport: "instances:export",
  instancesImport: "instances:import",
  instancesUsage: "instances:usage",

  javaReleases: "java:releases",
  javaSources: "java:sources",
  javaInstalled: "java:installed",
  javaInstall: "java:install",

  modsSearch: "mods:search",
  modsFiles: "mods:files",
  modsInstall: "mods:install",
  modsInstalled: "mods:installed",
  modsRemove: "mods:remove",
  modsUpdate: "mods:update",
  modsCheckUpdates: "mods:checkUpdates",
  modsDetail: "mods:detail",
  modsDependencies: "mods:dependencies",
  modsMaps: "mods:maps",
  modsInstallModpack: "mods:installModpack",
  modsCategories: "mods:categories",
  modsFilterOptions: "mods:filterOptions",
  skinsLocalList: "skins:localList",
  skinsLocalSelect: "skins:localSelect",
  skinsLocalImport: "skins:localImport",
  skinsLocalRemove: "skins:localRemove",
  skinsLocalApply: "skins:localApply",
  skinsLocalEnsureMod: "skins:localEnsureMod",
  capesList: "capes:list",
  capesImport: "capes:import",
  capesRemove: "capes:remove",
  capesSelect: "capes:select",
  serversCores: "servers:cores",
  serversBuilds: "servers:builds",
  serversList: "servers:list",
  serversCreate: "servers:create",
  serversRemove: "servers:remove",
  serversUpdate: "servers:update",
  serversStart: "servers:start",
  serversStop: "servers:stop",
  serversCommand: "servers:command",
  serversConsole: "servers:console",
  serversConsoleLine: "servers:consoleLine",
  serversStatus: "servers:status",
  modsInstalledContent: "mods:installedContent",
  instancesSetLoader: "instances:setLoader",
} as const;

export interface CreateInstanceRequest {
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  memoryMb?: number;
}

export interface ServerCreateRequest {
  name: string;
  core: ServerCoreId;
  mcVersion: string;
  coreVersion: string;
  port?: number;
  memoryMb?: number;
  maxPlayers?: number;
  onlineMode?: boolean;
}

export interface ModSearchRequest {
  /** 具体来源；source 缺省为 "all" 时忽略它，只用于单来源调用与结果归属。 */
  provider: ModProviderId;
  /** 来源过滤：具体站点或多来源并发合并（默认 all）。 */
  source?: ModSourceFilter;
  query: string;
  /** 内容类型（默认 mod）：光影/资源包/整合包走麦块社区各自的面板接口。 */
  kind?: ModContentKind;
  gameVersion?: string;
  loader?: LoaderKind;
  /** 分类 id（Modrinth 的 categories facet / 麦块条目的 categories 字段）。 */
  category?: string;
  /** 分辨率（资源包/光影）：Modrinth 用同名 category，麦块同样落在 categories 里。 */
  resolution?: string;
  limit?: number;
  offset?: number;
  sort?: "relevance" | "downloads" | "updated";
}

export interface ModFilesRequest {
  provider: ModProviderId;
  projectId: string;
  /** 内容类型（默认 mod）：光影/资源包/整合包不参与加载器筛选。 */
  kind?: ModContentKind;
  gameVersion?: string;
  loader?: LoaderKind;
  limit?: number;
}

export interface ModInstallRequest {
  provider: ModProviderId;
  projectId: string;
  fileId?: string;
  instanceId: string;
  /** 内容类型（默认 mod）：决定落盘目录（mods/shaderpacks/resourcepacks/modpacks）。 */
  kind?: ModContentKind;
  /** 是否连带安装缺失的必需前置（界面确认后传 true）。 */
  installDependencies?: boolean;
}

export interface ModInstallResult {
  fileName: string;
  path: string;
  /** 本次连带装上的前置（名称或文件名）。 */
  installedDependencies: string[];
}

/** The surface exposed on window.naiwa by the preload script. */
export interface NaiwaApi {
  app: {
    info(): Promise<AppInfo>;
    openRootDir(): Promise<void>;
    /** 打开根目录内的任意子目录（越界路径会被主进程拒绝）。 */
    openPath(path: string): Promise<void>;
    /** 复制文本到系统剪贴板（主进程 clipboard，避免渲染端权限问题）。 */
    copyText(text: string): Promise<void>;
    /** 判断本地路径是否存在（可用于校验实例指定的 Java 是否还有效）。 */
    pathExists(path: string): Promise<boolean>;
    /** 启动音效：返回 file:// URL（null 表示关闭或找不到）与音量。 */
    startupSound(): Promise<{ url: string | null; volume: number }>;
    /** 自定义界面图标的 file:// 直链（未选择或文件不存在时 url 为 null）。 */
    appIcon(): Promise<{ url: string | null; path: string | null }>;
    /** 检查软件更新（GitHub 仓库最新版本）。 */
    checkUpdates(): Promise<UpdateCheckResult>;
    /** 下载最新免安装版并替换当前程序，成功后自动重启（仅免安装版可用）。 */
      /** 下载并应用更新；url 只是提示，主进程会按当前是免安装版还是安装版自行选包。 */
    installUpdate(url?: string): Promise<void>;
    /** 在资源管理器里定位文件/文件夹（不受启动器根目录限制，用于导出结果）。 */
    revealInFolder(path: string): Promise<void>;
    /** 读取随程序分发的 CHANGELOG.md，按版本倒序返回（默认最多 3 段）。 */
    changelog(limit?: number): Promise<ChangelogSection[]>;
    /** 打开指定实例的模组目录（自动按版本隔离模式定位）。 */
    openInstanceMods(instanceId: string): Promise<void>;
    /** 打开指定实例的某一类内容目录：mod → mods、shader → shaderpacks、resourcepack → resourcepacks（跟随版本隔离设置）。 */
    openInstanceContent(instanceId: string, kind: ModContentKind): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  /** 本地 Wallpaper Engine 壁纸（Steam 创意工坊 431960）。 */
  wallpaper: {
    list(): Promise<WallpaperEntry[]>;
  };
  media: {
    /** 列出 NaiWa/backgrounds 与 NaiWa/music 下的可用文件。 */
    list(): Promise<MediaList>;
    /** 按设置里的随机图 API 取一张背景（主进程已下载到本地缓存）。失败返回 null。 */
    apiBackground(): Promise<ApiBackground | null>;
    /** 打开背景/音乐目录，方便用户放文件。 */
    openDir(kind: "backgrounds" | "music" | "icons"): Promise<void>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  downloads: {
    /** 全部下载/安装任务（含已中断的）。 */
    list(): Promise<DownloadJob[]>;
    /** 继续被中断的任务。 */
    resume(id: string): Promise<void>;
    /** 取消任务（标记为已取消/可继续，不删除进度）。 */
    cancel(id: string): Promise<void>;
    /** 从列表移除一条记录。 */
    remove(id: string): Promise<void>;
    /** 清空已完成记录。 */
    clearFinished(): Promise<void>;
    /** 任务列表变化时推送。 */
    onChanged(cb: (jobs: DownloadJob[]) => void): () => void;
  };
  net: {
    /** 本机局域网地址（用于「局域网联机」提示）。 */
    interfaces(): Promise<LanAddress[]>;
    /** TCP 探测某个 host:port 是否可连（用于中继/房间连通性检查）。 */
    probe(host: string, port: number): Promise<PortProbeResult>;
    /** 检查本机某端口当前是否被监听（游戏是否已开好房间）。 */
    portCheck(port: number): Promise<boolean>;
    /** 樱花穿透：账号信息（token 来自设置）。 */
    natfrpUser(): Promise<NatfrpUser>;
    /** 樱花穿透：隧道列表。 */
    natfrpTunnels(): Promise<NatfrpTunnel[]>;
    /** 樱花穿透：节点列表（用于创建隧道时选择）。 */
    natfrpNodes(): Promise<{ id: number; name: string; publicGameAllowed: boolean }[]>;
    /** 樱花穿透：创建 TCP 隧道（本地 25565 → 公网）。 */
    natfrpCreate(name: string, node: number, localPort: number): Promise<{ id: number; name: string }>;
    /** 樱花穿透：当前 frpc 运行状态。 */
    natfrpStatus(): Promise<NatfrpStatus>;
    /** 樱花穿透：启动某条隧道（必要时先下载 frpc）。 */
    natfrpStart(tunnelId: number): Promise<NatfrpStatus>;
    /** 樱花穿透：停止。 */
    natfrpStop(): Promise<NatfrpStatus>;
  };
  sources: {
    list(): Promise<DownloadSourceInfo[]>;
    probe(): Promise<SourceProbe[]>;
    set(id: DownloadSourceId): Promise<Settings>;
  };
  accounts: {
    list(): Promise<Account[]>;
    createOffline(name: string): Promise<Account>;
    remove(id: string): Promise<void>;
    setActive(id: string): Promise<void>;
    /** 第三方（Yggdrasil）账号登录：校验地址后换取令牌并保存账号。 */
    loginYggdrasil(apiUrl: string, username: string, password: string): Promise<Account>;
    /** 用已保存的令牌校验/刷新第三方账号（返回是否仍有效）。 */
    validateYggdrasil(id: string): Promise<{ ok: boolean; name?: string; uuid?: string; error?: string }>;
    /** 读取该账号当前皮肤/披风信息。 */
    skin(id: string): Promise<SkinInfo>;
    /** 选择本地皮肤图片（打开文件框），返回绝对路径或 null。 */
    pickSkinFile(): Promise<string | null>;
    /** 上传并应用皮肤。 */
    uploadSkin(id: string, filePath: string, model: "classic" | "slim"): Promise<void>;
    /** 恢复默认皮肤。 */
    resetSkin(id: string): Promise<void>;
    /** 本地衣柜（NaiWa/skins 下的图片）。 */
    wardrobe(): Promise<WardrobeSkin[]>;
    /** 把本地图片复制进衣柜，返回文件名。 */
    addToWardrobe(filePath: string): Promise<string>;
    /** 从衣柜删除。 */
    removeFromWardrobe(name: string): Promise<void>;
    /** 该账号可用角色（第三方账号有多个）。 */
    skinProfiles(id: string): Promise<SkinProfile[]>;
    /** 切换当前使用角色。 */
    selectProfile(id: string, profileId: string): Promise<void>;
    /** 启动微软设备码登录，返回要展示给用户的 code 与链接。 */
    beginMicrosoft(): Promise<DeviceCodeChallenge>;
    /** 轮询登录结果：pending 表示用户还没授权。 */
    pollMicrosoft(deviceCode: string): Promise<MicrosoftLoginState>;
  };
  versions: {
    list(forceRefresh?: boolean): Promise<VersionBrief[]>;
    loaders(mcVersion: string, loader: LoaderKind): Promise<LoaderVersionInfo[]>;
  };
  instances: {
    list(): Promise<InstanceMeta[]>;
    create(req: CreateInstanceRequest): Promise<InstanceMeta>;
    update(id: string, patch: Partial<InstanceMeta>): Promise<InstanceMeta>;
    remove(id: string): Promise<void>;
    /** quickPlayLevel 传存档文件夹名时直接进该存档；传 "__new__" 让游戏新建并进入。 */
    launch(id: string, quickPlayLevel?: string): Promise<void>;
    /** 列出该实例的单人存档（读 saves/ 目录）。 */
    saves(id: string): Promise<SaveInfo[]>;
    /** 把实例打包成 .zip（含清单），供分享给别人导入。 */
    exportArchive(id: string): Promise<InstanceExportResult>;
    /** 选择并导入别人分享的实例压缩包。 */
    importArchive(): Promise<InstanceImportResult>;
    /** 统计实例占用的本地空间（force=true 跳过缓存重算）。 */
    usage(id: string, force?: boolean): Promise<{ bytes: number }>;
    /** 切换加载器：安装新加载器版本并清理旧版本目录，模组目录保持不变。 */
    setLoader(id: string, loader: LoaderKind, loaderVersion?: string): Promise<InstanceMeta>;
  };
  java: {
    /** 可下载的 JDK 列表；source 缺省用设置里的 javaDownloadSource，auto 会先测速挑源。 */
    releases(majors?: number[], source?: JavaSourceId): Promise<JavaRelease[]>;
    installed(): Promise<InstalledJava[]>;
    install(major: number, version: string, source?: JavaSourceId): Promise<InstalledJava>;
    /** 三个下载源的探测结果（耗时越低越优先）；「自动」按它挑源。 */
    sources(): Promise<JavaSourceProbe[]>;
  };
  mods: {
    search(req: ModSearchRequest): Promise<ModSearchResult[]>;
    /** 模组详细资料（介绍/画廊/许可/链接，含可用的中文翻译）。 */
    detail(provider: ModProviderId, projectId: string): Promise<ModDetail>;
    files(req: ModFilesRequest): Promise<ModFileInfo[]>;
    install(req: ModInstallRequest): Promise<ModInstallResult>;
    /** 查询某个文件（或项目当前最优文件）的必需前置，并标注实例里是否已装；kind 决定是否套用光影内置规则。 */
    dependencies(provider: ModProviderId, projectId: string, instanceId: string, fileId?: string, kind?: ModContentKind): Promise<ModDependency[]>;
    /** 麦块社区地图列表（可按实例标注版本兼容性）。 */
    maps(query: string, page: number, instanceId?: string): Promise<MapEntry[]>;
    /** 某内容类型的分类列表（分类下拉/侧栏）。 */
    categories(kind: ModContentKind, source: ModSourceFilter): Promise<ModCategory[]>;
    /** 某内容类型可用的筛选项（版本/加载器/分辨率）。 */
    filterOptions(kind: ModContentKind): Promise<ModFilterOptions>;
    /** 一键安装整合包：下载 .mrpack → 新建实例（名字默认取整合包名）→ 装加载器/模组。 */
    installModpack(provider: ModProviderId, projectId: string, fileId?: string, instanceName?: string): Promise<{ instanceId: string; name: string }>;
    /** 实例里已装的内容（kind 缺省为 mod）：mod → mods 的 .jar，shader → shaderpacks，resourcepack → resourcepacks。 */
    installed(instanceId: string, kind?: ModContentKind): Promise<InstalledModInfo[]>;
    /** 逐个文件反查远端，填充 update 字段（光影/资源包同样按 sha1 反查）。 */
    checkUpdates(instanceId: string, kind?: ModContentKind): Promise<InstalledModInfo[]>;
    /** 删除实例对应目录中的某个文件（同名 .bak 一并清掉）：模组只认 .jar，光影/资源包只认 .zip。 */
    remove(instanceId: string, fileName: string, kind?: ModContentKind): Promise<void>;
    /** 把某个内容更新到适配当前实例的最佳版本，返回新文件名。 */
    update(instanceId: string, fileName: string, kind?: ModContentKind): Promise<{ fileName: string; path: string }>;
    /** 实例里已装内容的索引记录（资源页判断重复安装用；文件已被删除的记录不返回）。 */
    installedContent(instanceId: string): Promise<InstalledContentRef[]>;
  };
  /** 本地皮肤库：与账号解耦，账号只负责提供预览用的昵称。 */
  skinsLocal: {
    /** 列出官方内置与用户导入的皮肤；accountId 用于标记哪个是当前选中的。 */
    list(accountId?: string): Promise<LocalSkin[]>;
    /** 选中/取消选中某账号的本地皮肤（fileName 传 null 表示跟随账号原皮肤）。 */
    select(accountId: string, fileName: string | null): Promise<LocalSkin[]>;
    /** 导入皮肤文件（拖放/选择框拿到的绝对路径），返回导入与跳过的文件名。 */
    import(filePaths: string[]): Promise<{ imported: string[]; skipped: string[] }>;
    /** 删除用户导入的皮肤（官方内置的不能删）。 */
    remove(fileName: string): Promise<LocalSkin[]>;
    /** 把账号当前选中的皮肤写进实例（CustomSkinLoader 本地皮肤目录）。 */
    applyToInstance(instanceId: string, accountId: string): Promise<SkinApplyResult>;
    /** 一键把 CustomSkinLoader 装进实例。 */
    ensureMod(instanceId: string): Promise<{ installed: boolean; fileName?: string; message?: string }>;
    /** 拖放进来的 File 拿绝对路径（Electron 38 只允许经 webUtils 取，渲染层不能直接用 file.path）。 */
    pathForFile(file: File): string;
  };
  /** 开服：服务端列表、下载、进程与控制台。 */
  servers: {
    /** FastMirror 的核心清单（含各自支持的游戏版本）。 */
    cores(): Promise<ServerCoreInfo[]>;
    /** 某核心某游戏版本的构建列表。 */
    builds(core: ServerCoreId, mcVersion: string): Promise<ServerBuildInfo[]>;
    list(): Promise<ServerEntry[]>;
    /** 新建：创建目录、下载 jar、写 eula.txt 与 server.properties。 */
    create(req: ServerCreateRequest): Promise<ServerEntry>;
    remove(id: string): Promise<void>;
    /** 只允许改 name / port / memoryMb / maxPlayers / onlineMode / eulaAgreed。 */
    update(id: string, patch: Partial<Pick<ServerMeta, "name" | "port" | "memoryMb" | "maxPlayers" | "onlineMode" | "eulaAgreed">>): Promise<ServerEntry>;
    start(id: string): Promise<ServerEntry>;
    stop(id: string): Promise<ServerEntry>;
    /** 往服务端控制台发一条命令（等价敲回车）。 */
    command(id: string, line: string): Promise<void>;
    /** 取回最近的日志缓冲（打开控制台时先拉一次）。 */
    console(id: string, limit?: number): Promise<ServerConsoleLine[]>;
    /** 控制台新行推送。 */
    onConsole(cb: (line: ServerConsoleLine) => void): () => void;
    /** 列表状态变化推送（启动/停止/崩溃）。 */
    onStatus(cb: (entries: ServerEntry[]) => void): () => void;
  };
  /** 本地披风库：微软账号只读官方披风，离线账号可选本地披风并应用。 */
  capes: {
    list(accountId?: string): Promise<LocalCape[]>;
    import(filePaths: string[]): Promise<{ imported: string[]; skipped: string[] }>;
    remove(fileName: string): Promise<LocalCape[]>;
    select(accountId: string, fileName: string | null): Promise<LocalCape[]>;
    /** 拖放拿绝对路径（与皮肤同一个 webUtils 通道）。 */
    pathForFile(file: File): string;
  };
  events: {
    onProgress(cb: (p: TaskProgress) => void): () => void;
    onTaskDone(cb: (r: TaskResult) => void): () => void;
    onLog(cb: (l: LogLine) => void): () => void;
  };
}
