import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join, relative, resolve } from "node:path";
import { access, mkdir, readdir } from "node:fs/promises";
import { IPC } from "../../shared/ipc";
import type {
  CreateInstanceRequest, ModFilesRequest, ModInstallRequest, ModInstallResult, ModSearchRequest,
} from "../../shared/ipc";
import type { Account, AppInfo, DeviceCodeChallenge, DownloadJob, DownloadSourceId, InstanceMeta, InstalledContentRef, InstalledModInfo, LanAddress, ChangelogSection, JavaRelease, JavaSourceId, JavaSourceProbe, LocalCape, LocalSkin, LoaderKind, InstanceExportResult, InstanceImportResult, MapEntry, ModCategory, SkinApplyResult, SkinInfo, SkinProfile, WardrobeSkin, ModContentKind, ModFilterOptions, ModSourceFilter, NatfrpStatus, NatfrpTunnel, NatfrpUser, MediaList, MicrosoftLoginState, ModDependency, ModDetail, ModProviderId, PortProbeResult, SaveInfo, UpdateCheckResult, Settings } from "../../shared/types";
import { getPaths, instanceModsDir } from "../core/paths";
import { getSettings, updateSettings } from "../core/settings";
import { syncTray } from "../tray";
import { checkAppUpdates } from "../core/updates";
import { getChangelog } from "../core/changelog";
import { installUpdate } from "../core/updater";
import { isPortListening, listLanAddresses, probeTcp } from "../net/index";
import { natfrpCreate, natfrpNodes, natfrpStart, natfrpStatus, natfrpStop, natfrpTunnels, natfrpUser } from "../net/natfrp";
import { createOffline, listAccounts, removeAccount, setActiveAccount } from "../auth/accounts";
import { beginDeviceCode, pollDeviceCode } from "../auth/microsoft";
import { loginYggdrasil, validateYggdrasilAccount } from "../auth/yggdrasil";
import { addToWardrobe, getSkin, listSkinProfiles, listWardrobe, pickSkinFile, removeFromWardrobe, resetSkin, selectProfile, uploadSkin } from "../auth/skin";
import {
  applyToInstance, ensureMod, importLocalSkins, listLocalSkins, removeLocalSkin, selectLocalSkin,
} from "../skins/local";
import { importCapes, listCapes, removeCape, selectCape } from "../skins/capes";
import { SOURCES, probeSources, setActiveSource } from "../core/sources";
import { listVersions } from "../minecraft/manifest";
import { createInstance, deleteInstance, instanceDiskUsage, listInstances, listSaves, setLoader, updateInstance } from "../minecraft/instances";
import { exportInstance, importInstance } from "../minecraft/share";
import { launchInstance } from "../minecraft/launch";
import { installLoader, listLoaderVersions } from "../loaders/index";
import { installJava, listInstalledJava, listJavaReleases, listJavaSources } from "../java/index";
import { contentDirForInstance } from "../mods/install";
import { listMapEntries } from "../mods/minekuai";
import { checkUpdates, getModDependencies, getModDetail, installMod, installed, listInstalledContent, listInstalledMods, installModpack, listCategories, listFilterOptions, listModFiles, remove as removeMod, searchMods, update as updateMod } from "../mods/index";
import {
  cancel as cancelDownloadJob, clearFinished as clearFinishedDownloads, hintNextJob, list as listDownloadJobs,
  ready as readyDownloadJobs, remove as removeDownloadJob, resume as resumeDownloadJob, runCancellable,
} from "../downloads/index";
import type { ServerCreateRequest } from "../../shared/ipc";
import type {
  ServerBuildInfo, ServerConsoleLine, ServerCoreId, ServerCoreInfo, ServerEntry, ServerMeta,
} from "../../shared/types";
import {
  builds as listServerBuilds, consoleLines as readServerConsole, cores as listServerCores,
  createServer, installLifecycle as installServerLifecycle, listEntries as listServerEntries,
  removeServer, sendCommand as sendServerCommand, startServer, stopServer, updateServer,
} from "../servers/index";

const handle = <T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void => {
  ipcMain.handle(channel, async (_event, ...args: any[]) => fn(...args));
};

/** 背景除了静态图还支持视频（渲染层按扩展名决定用 img 还是 video；music/icons 仍只认图片/音频）。 */
const BACKGROUND_EXT = /.(png|jpe?g|webp|gif|bmp|mp4|webm|ogv)$/i;
const AUDIO_EXT = /.(mp3|ogg|wav|flac|m4a)$/i;

function mediaDirs(): { backgrounds: string; music: string; icons: string } {
  return {
    backgrounds: join(getPaths().dataRoot, "backgrounds"),
    music: join(getPaths().dataRoot, "music"),
    icons: join(getPaths().dataRoot, "icons"),
  };
}

async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && pattern.test(e.name)).map((e) => e.name).sort();
}

/** 只允许打开启动器根目录内的路径，避免被渲染进程诱导打开任意位置。 */
function assertInsideRoot(target: string): string {
  const root = getPaths().root;
  const resolved = resolve(target);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel.includes(":")) throw new Error(`拒绝打开根目录之外的路径：${target}`);
  return resolved;
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

export function registerIpc(): void {
  // 退出前确认：还有服务端在跑就先 stop（超时 kill），不留幽灵 java 进程
  installServerLifecycle();

  handle<AppInfo>(IPC.appInfo, () => ({
    nameEn: "NaiWa Launcher",
    nameZh: "奶娃启动器",
    developer: "奶龙",
    version: app.getVersion(),
    rootDir: getPaths().root,
    gameRoot: getPaths().gameRoot,
  }));
  handle<void>(IPC.openRootDir, async () => { await shell.openPath(getPaths().root); });
  handle<void>(IPC.copyText, (text: string) => { clipboard.writeText(String(text ?? "")); });
  // 不限制在根目录内：实例的 Java 可能装在 C:\Program Files 等外部位置
  // 启动音效：默认用打包进 resources 的 bgm，也可选 NaiWa/music 里的文件，或关闭
  handle<{ url: string | null; volume: number }>(IPC.startupSound, async () => {
    const settings = getSettings();
    const toFileUrl = (abs: string): string => "file:///" + abs.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
    const volume = Math.min(1, Math.max(0, settings.startupVolume));
    if (settings.startupSound === "off") return { url: null, volume };
    const target = settings.startupSound
      ? join(getPaths().dataRoot, "music", settings.startupSound)
      : app.isPackaged
        ? join(process.resourcesPath, "startup-bgm.mp3")
        : join(getPaths().root, "resources", "startup-bgm.mp3");
    try { await access(target); return { url: toFileUrl(target), volume }; } catch { return { url: null, volume }; }
  });

  handle<boolean>(IPC.pathExists, async (target: string) => {
    if (!target || !target.trim()) return false;
    try { await access(target); return true; } catch { return false; }
  });

  handle<void>(IPC.openPath, async (target: string) => {
    const error = await shell.openPath(assertInsideRoot(target));
    if (error) throw new Error(error);
  });

  handle<void>(IPC.openExternal, async (url: string) => { await shell.openExternal(url); });
  // 隔离模式决定模组目录：all → 实例目录；none → <gameRoot>/mods
  handle<void>(IPC.openInstanceMods, async (instanceId: string) => {
    const dir = getSettings().versionIsolation === "none" ? join(getPaths().gameRoot, "mods") : instanceModsDir(instanceId);
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(assertInsideRoot(dir));
    if (error) throw new Error(error);
  });

  // 实例里的三类内容目录：光影/材质与模组一样跟随版本隔离设置，目录不存在就先建出来
  handle<void>(IPC.openInstanceContent, async (instanceId: string, kind: ModContentKind) => {
    const dir = contentDirForInstance({ id: instanceId }, kind);
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(assertInsideRoot(dir));
    if (error) throw new Error(error);
  });

  // 自定义界面图标：选中的图标存在就返回 file:// 直链，否则 null
  handle<UpdateCheckResult>(IPC.appCheckUpdates, () => checkAppUpdates());
  handle<void>(IPC.appInstallUpdate, (url?: string) => installUpdate(url));
  // 导出到系统目录后的「打开所在文件夹」：shell.showItemInFolder 不受启动器根目录守卫限制
  handle<ChangelogSection[]>(IPC.appChangelog, (limit?: number) => getChangelog(limit));
  handle<void>(IPC.appReveal, (target: string) => {
    if (!target) throw new Error("路径为空");
    shell.showItemInFolder(resolve(target));
  });

  handle<{ url: string | null; path: string | null }>(IPC.appIcon, async () => {
    const name = getSettings().appIcon;
    if (!name) return { url: null, path: null };
    const abs = join(getPaths().dataRoot, "icons", name);
    try {
      await access(abs);
      const url = "file:///" + abs.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
      return { url, path: abs };
    } catch {
      return { url: null, path: null };
    }
  });

  handle<NatfrpUser>(IPC.natfrpUser, () => natfrpUser());
  handle<NatfrpTunnel[]>(IPC.natfrpTunnels, () => natfrpTunnels());
  handle<{ id: number; name: string; publicGameAllowed: boolean }[]>(IPC.natfrpNodes, () => natfrpNodes());
  handle<{ id: number; name: string }>(IPC.natfrpCreate, (name: string, node: number, localPort: number) => natfrpCreate(name, node, localPort));
  handle<NatfrpStatus>(IPC.natfrpStatus, () => natfrpStatus());
  handle<NatfrpStatus>(IPC.natfrpStart, (tunnelId: number) => natfrpStart(tunnelId));
  handle<NatfrpStatus>(IPC.natfrpStop, () => natfrpStop());

  handle<LanAddress[]>(IPC.netInterfaces, () => listLanAddresses());
  handle<PortProbeResult>(IPC.netProbe, (host: string, port: number) => probeTcp(host, port));
  handle<boolean>(IPC.netPortCheck, (port: number) => isPortListening(port));

  handle<MediaList>(IPC.mediaList, async () => {
    const dirs = mediaDirs();
    return {
      backgrounds: await listFiles(dirs.backgrounds, BACKGROUND_EXT),
      music: await listFiles(dirs.music, AUDIO_EXT),
      icons: await listFiles(dirs.icons, /.(png|ico|jpe?g|webp)$/i),
      dirs,
    };
  });

  handle<void>(IPC.windowMinimize, () => { focusedWindow()?.minimize(); });
  handle<boolean>(IPC.windowToggleMaximize, () => {
    const win = focusedWindow();
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handle<void>(IPC.windowClose, () => { focusedWindow()?.close(); });
  handle<boolean>(IPC.windowIsMaximized, () => focusedWindow()?.isMaximized() ?? false);

  handle<Settings>(IPC.settingsGet, () => getSettings());
  handle<Settings>(IPC.settingsUpdate, async (patch: Partial<Settings>) => {
    const next = await updateSettings(patch);
    // 「关闭到托盘」是窗口行为，改完立刻让托盘图标出现/消失
    if ("closeToTray" in patch) {
      const { BrowserWindow } = await import("electron");
      syncTray(() => BrowserWindow.getAllWindows()[0] ?? null, () => app.quit());
    }
    setActiveSource(next.downloadSource);
    return next;
  });

  handle<Account[]>(IPC.accountsList, () => listAccounts());
  handle<Account>(IPC.accountsCreateOffline, (name: string) => createOffline(name));
  handle<void>(IPC.accountsRemove, (id: string) => removeAccount(id));
  handle<Account>(IPC.accountsLoginYggdrasil, (apiUrl: string, username: string, password: string) => loginYggdrasil(apiUrl, username, password));
  handle<{ ok: boolean; name?: string; uuid?: string; error?: string }>(IPC.accountsValidateYggdrasil, (id: string) => validateYggdrasilAccount(id));

  handle<SkinInfo>(IPC.skinsGet, (id: string) => getSkin(id));
  handle<string | null>(IPC.skinsPickFile, () => pickSkinFile());
  handle<void>(IPC.skinsUpload, (id: string, filePath: string, model: "classic" | "slim") => uploadSkin(id, filePath, model));
  handle<void>(IPC.skinsReset, (id: string) => resetSkin(id));
  handle<WardrobeSkin[]>(IPC.skinsWardrobe, () => listWardrobe());
  handle<string>(IPC.skinsAddToWardrobe, (filePath: string) => addToWardrobe(filePath));
  handle<void>(IPC.skinsRemoveFromWardrobe, (name: string) => removeFromWardrobe(name));
  handle<SkinProfile[]>(IPC.skinsProfiles, (id: string) => listSkinProfiles(id));
  handle<void>(IPC.skinsSelectProfile, (id: string, profileId: string) => selectProfile(id, profileId));
  // 本地皮肤库（与账号解耦）：官方内置只读 + 用户导入，选中后写进实例的 CustomSkinLoader 本地皮肤目录
  handle<LocalSkin[]>(IPC.skinsLocalList, (accountId?: string) => listLocalSkins(accountId));
  handle<LocalSkin[]>(IPC.skinsLocalSelect, (accountId: string, fileName: string | null) =>
    selectLocalSkin(accountId, fileName),
  );
  handle<{ imported: string[]; skipped: string[] }>(IPC.skinsLocalImport, (filePaths: string[]) =>
    importLocalSkins(Array.isArray(filePaths) ? filePaths : []),
  );
  handle<LocalSkin[]>(IPC.skinsLocalRemove, (fileName: string) => removeLocalSkin(fileName));
  handle<SkinApplyResult>(IPC.skinsLocalApply, (instanceId: string, accountId: string) =>
    applyToInstance(instanceId, accountId),
  );
  handle<{ installed: boolean; fileName?: string; message?: string }>(IPC.skinsLocalEnsureMod, (instanceId: string) =>
    ensureMod(instanceId),
  );
  // 本地披风库：只给离线账号用（微软账号读官方披风，不经过这里）
  handle<LocalCape[]>(IPC.capesList, (accountId?: string) => listCapes(accountId));
  handle<{ imported: string[]; skipped: string[] }>(IPC.capesImport, (filePaths: string[]) =>
    importCapes(Array.isArray(filePaths) ? filePaths : []),
  );
  handle<LocalCape[]>(IPC.capesRemove, (fileName: string) => removeCape(fileName));
  handle<LocalCape[]>(IPC.capesSelect, (accountId: string, fileName: string | null) => selectCape(accountId, fileName));

  handle<void>(IPC.accountsSetActive, (id: string) => setActiveAccount(id));
  handle<DeviceCodeChallenge>(IPC.accountsBeginMicrosoft, () => beginDeviceCode());
  handle<MicrosoftLoginState>(IPC.accountsPollMicrosoft, (deviceCode: string) => pollDeviceCode(deviceCode));

  handle(IPC.sourcesList, () => SOURCES);
  handle(IPC.sourcesProbe, () => probeSources());
  handle<Settings>(IPC.sourcesSet, async (id: DownloadSourceId) => updateSettings({ downloadSource: id }));

  handle(IPC.versionsList, (forceRefresh: boolean) => listVersions(forceRefresh));
  handle(IPC.loadersList, (mcVersion: string, loader: InstanceMeta["loader"]) => listLoaderVersions(mcVersion, loader));

  handle(IPC.instancesList, () => listInstances());
  handle<InstanceMeta>(IPC.instancesCreate, (req: CreateInstanceRequest) => {
    // 记下重试参数：任务被中断后按 kind=version 重放 installVersion
    hintNextJob({ kind: "version", detail: req.mcVersion, resume: JSON.stringify({ mcVersion: req.mcVersion }) });
    // 走 runCancellable：下载记录列表里的「终止」才能真的中断这次安装
    return runCancellable((signal) => createInstance(req, signal));
  });
  handle<InstanceMeta>(IPC.instancesUpdate, (id: string, patch: Partial<InstanceMeta>) => updateInstance(id, patch));
  handle<void>(IPC.instancesDelete, (id: string) => deleteInstance(id));
  handle<{ bytes: number }>(IPC.instancesUsage, (id: string, force?: boolean) => instanceDiskUsage(id, force === true));
  handle<InstanceExportResult>(IPC.instancesExport, (id: string) => exportInstance(id));
  handle<InstanceImportResult>(IPC.instancesImport, () => importInstance());
  handle<SaveInfo[]>(IPC.instancesSaves, (id: string) => listSaves(id));
  handle<void>(IPC.instancesLaunch, async (id: string, quickPlayLevel?: string) => {
    await launchInstance(id, quickPlayLevel);
    // 启动器可见性：游戏拉起后按设置处理启动器窗口
    const visibility = getSettings().launcherVisibility;
    const win = focusedWindow();
    if (!win || visibility === "keep") return;
    if (visibility === "minimize") win.minimize();
    else if (visibility === "close") win.close();
  });
  handle<InstanceMeta>(IPC.instancesSetLoader, async (id: string, loader: LoaderKind, loaderVersion?: string) => {
    const instance = (await listInstances()).find((item) => item.id === id);
    if (instance) {
      hintNextJob({ kind: "loader", detail: `${loader} ${loaderVersion ?? ""}`.trim(), resume: JSON.stringify({ mcVersion: instance.mcVersion, loader, loaderVersion }) });
    }
    return runCancellable((signal) => setLoader(id, loader, loaderVersion, signal));
  });

  // source 缺省由主进程取设置里的 javaDownloadSource；"auto" 会先探测三个源再挑最快的
  handle<JavaRelease[]>(IPC.javaReleases, (source?: JavaSourceId) => listJavaReleases(source));
  handle<JavaSourceProbe[]>(IPC.javaSources, () => listJavaSources());
  handle(IPC.javaInstalled, () => listInstalledJava());
  handle(IPC.javaInstall, (major: number, version: string, source?: JavaSourceId) => {
    hintNextJob({ kind: "java", detail: `JDK ${major}`, resume: JSON.stringify({ major, version }) });
    return runCancellable((signal) => installJava(major, version, source, signal));
  });

  handle(IPC.modsSearch, (req: ModSearchRequest) => searchMods(req));
  handle<{ instanceId: string; name: string }>(IPC.modsInstallModpack, (provider: ModProviderId, projectId: string, fileId?: string, instanceName?: string) =>
    runCancellable((signal) => installModpack(provider, projectId, fileId, instanceName, signal)),
  );
  handle<ModCategory[]>(IPC.modsCategories, (kind: ModContentKind, source: ModSourceFilter) => listCategories(kind, source));
  handle<ModFilterOptions>(IPC.modsFilterOptions, (kind: ModContentKind) => listFilterOptions(kind));
  handle<MapEntry[]>(IPC.modsMaps, (query: string, page: number, instanceId?: string) => listMapEntries(query, page, instanceId));
  handle<ModDetail>(IPC.modsDetail, (provider: ModProviderId, projectId: string) => getModDetail(provider, projectId));
  handle(IPC.modsFiles, (req: ModFilesRequest) => listModFiles(req));
  handle<ModInstallResult>(IPC.modsInstall, (req: ModInstallRequest) => {
    hintNextJob({ kind: "content", detail: req.instanceId, resume: JSON.stringify(req) });
    return runCancellable((signal) => installMod(req, signal));
  });
  // kind 由渲染进程按当前的资源类型传入（缺省 mod）：内容管理页对光影/资源包复用同一套接口
  handle<ModDependency[]>(IPC.modsDependencies, (provider: ModProviderId, projectId: string, instanceId: string, fileId?: string, kind?: ModContentKind) =>
    getModDependencies(provider, projectId, instanceId, fileId, kind),
  );
  handle<InstalledModInfo[]>(IPC.modsInstalled, (instanceId: string, kind?: ModContentKind) => installed(instanceId, kind));
  handle<InstalledModInfo[]>(IPC.modsCheckUpdates, (instanceId: string, kind?: ModContentKind) => checkUpdates(instanceId, kind));
  handle<void>(IPC.modsRemove, (instanceId: string, fileName: string, kind?: ModContentKind) => removeMod(instanceId, fileName, kind));
  handle<{ fileName: string; path: string }>(IPC.modsUpdate, (instanceId: string, fileName: string, kind?: ModContentKind) =>
    updateMod(instanceId, fileName, kind),
  );
  // 只读：资源页下载前的重复安装检测（索引记录 + 磁盘核对，同名不同目录不算）
  handle<InstalledContentRef[]>(IPC.modsInstalledContent, (instanceId: string) => listInstalledContent(instanceId));

  // 下载记录：持久化的安装任务列表，重启后可继续
  // 下载记录在窗口起来之后才异步读盘（启动路径不再等它）：这里等它一次，界面不会读到空列表
  handle<DownloadJob[]>(IPC.downloadsList, async () => {
    await readyDownloadJobs();
    return listDownloadJobs();
  });
  handle<void>(IPC.downloadsResume, (id: string) => resumeDownloadJob(id));
  handle<void>(IPC.downloadsCancel, (id: string) => cancelDownloadJob(id));
  handle<void>(IPC.downloadsRemove, (id: string) => removeDownloadJob(id));
  handle<void>(IPC.downloadsClearFinished, () => clearFinishedDownloads());

  // 开服：FastMirror 核心/构建、服务端增删改、进程与控制台（签名与 NaiwaApi.servers 逐位对齐）
  handle<ServerCoreInfo[]>(IPC.serversCores, () => listServerCores());
  handle<ServerBuildInfo[]>(IPC.serversBuilds, (core: ServerCoreId, mcVersion: string) => listServerBuilds(core, mcVersion));
  handle<ServerEntry[]>(IPC.serversList, () => listServerEntries());
  handle<ServerEntry>(IPC.serversCreate, (req: ServerCreateRequest) => createServer(req));
  handle<void>(IPC.serversRemove, (id: string) => removeServer(id));
  handle<ServerEntry>(IPC.serversUpdate, (
    id: string,
    patch: Partial<Pick<ServerMeta, "name" | "port" | "memoryMb" | "maxPlayers" | "onlineMode" | "eulaAgreed">>,
  ) => updateServer(id, patch));
  handle<ServerEntry>(IPC.serversStart, (id: string) => startServer(id));
  handle<ServerEntry>(IPC.serversStop, (id: string) => stopServer(id));
  handle<void>(IPC.serversCommand, (id: string, line: string) => sendServerCommand(id, line));
  handle<ServerConsoleLine[]>(IPC.serversConsole, (id: string, limit?: number) => readServerConsole(id, limit));
}