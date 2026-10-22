import type {
  Account, AppInfo, DeviceCodeChallenge, DownloadSourceId, DownloadSourceInfo, InstanceMeta, InstalledJava,
  DownloadJob, InstalledModInfo, JavaRelease, LanAddress, MapEntry, NatfrpStatus, NatfrpTunnel, NatfrpUser, ModContentKind, MediaList, MicrosoftLoginState, ModDependency,
  PortProbeResult, SaveInfo, UpdateCheckResult, InstanceExportResult, InstanceImportResult,
  LoaderKind, LoaderVersionInfo, LogLine, ModCategory, ModFileInfo, ModFilterOptions, ModProviderId,
  ModSearchResult, ModSourceFilter, Settings, SkinInfo, ModDetail, SourceProbe, TaskProgress, TaskResult, VersionBrief,
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
  openRootDir: "app:openRootDir",
  log: "app:log",

  mediaList: "media:list",
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

  javaReleases: "java:releases",
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
  instancesSetLoader: "instances:setLoader",
} as const;

export interface CreateInstanceRequest {
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  memoryMb?: number;
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
    installUpdate(url: string): Promise<void>;
    /** 在资源管理器里定位文件/文件夹（不受启动器根目录限制，用于导出结果）。 */
    revealInFolder(path: string): Promise<void>;
    /** 打开指定实例的模组目录（自动按版本隔离模式定位）。 */
    openInstanceMods(instanceId: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  media: {
    /** 列出 NaiWa/backgrounds 与 NaiWa/music 下的可用文件。 */
    list(): Promise<MediaList>;
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
    /** 切换加载器：安装新加载器版本并清理旧版本目录，模组目录保持不变。 */
    setLoader(id: string, loader: LoaderKind, loaderVersion?: string): Promise<InstanceMeta>;
  };
  java: {
    releases(): Promise<JavaRelease[]>;
    installed(): Promise<InstalledJava[]>;
    install(major: number, version: string): Promise<InstalledJava>;
  };
  mods: {
    search(req: ModSearchRequest): Promise<ModSearchResult[]>;
    /** 模组详细资料（介绍/画廊/许可/链接，含可用的中文翻译）。 */
    detail(provider: ModProviderId, projectId: string): Promise<ModDetail>;
    files(req: ModFilesRequest): Promise<ModFileInfo[]>;
    install(req: ModInstallRequest): Promise<ModInstallResult>;
    /** 查询某个文件（或项目当前最优文件）的必需前置，并标注实例里是否已装。 */
    dependencies(provider: ModProviderId, projectId: string, instanceId: string, fileId?: string): Promise<ModDependency[]>;
    /** 麦块社区地图列表（可按实例标注版本兼容性）。 */
    maps(query: string, page: number, instanceId?: string): Promise<MapEntry[]>;
    /** 某内容类型的分类列表（分类下拉/侧栏）。 */
    categories(kind: ModContentKind, source: ModSourceFilter): Promise<ModCategory[]>;
    /** 某内容类型可用的筛选项（版本/加载器/分辨率）。 */
    filterOptions(kind: ModContentKind): Promise<ModFilterOptions>;
    /** 一键安装整合包：下载 .mrpack → 新建实例（名字默认取整合包名）→ 装加载器/模组。 */
    installModpack(provider: ModProviderId, projectId: string, fileId?: string, instanceName?: string): Promise<{ instanceId: string; name: string }>;
    installed(instanceId: string): Promise<InstalledModInfo[]>;
    /** 逐个文件反查远端，填充 update 字段。 */
    checkUpdates(instanceId: string): Promise<InstalledModInfo[]>;
    /** 删除实例 mods 目录中的某个 jar（同名 .bak 一并清掉）。 */
    remove(instanceId: string, fileName: string): Promise<void>;
    /** 把某个模组更新到适配当前实例的最佳版本，返回新文件名。 */
    update(instanceId: string, fileName: string): Promise<{ fileName: string; path: string }>;
  };
  events: {
    onProgress(cb: (p: TaskProgress) => void): () => void;
    onTaskDone(cb: (r: TaskResult) => void): () => void;
    onLog(cb: (l: LogLine) => void): () => void;
  };
}
