import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join, relative, resolve } from "node:path";
import { access, mkdir, readdir } from "node:fs/promises";
import { IPC } from "../../shared/ipc";
import type {
  CreateInstanceRequest, ModFilesRequest, ModInstallRequest, ModInstallResult, ModSearchRequest,
} from "../../shared/ipc";
import type { Account, AppInfo, DeviceCodeChallenge, DownloadJob, DownloadSourceId, InstanceMeta, InstalledModInfo, LanAddress, LoaderKind, MapEntry, ModCategory, ModContentKind, ModFilterOptions, ModSourceFilter, NatfrpStatus, NatfrpTunnel, NatfrpUser, MediaList, MicrosoftLoginState, ModDependency, ModDetail, ModProviderId, PortProbeResult, SaveInfo, UpdateCheckResult, Settings } from "../../shared/types";
import { getPaths, instanceModsDir } from "../core/paths";
import { getSettings, updateSettings } from "../core/settings";
import { checkAppUpdates } from "../core/updates";
import { isPortListening, listLanAddresses, probeTcp } from "../net/index";
import { natfrpCreate, natfrpNodes, natfrpStart, natfrpStatus, natfrpStop, natfrpTunnels, natfrpUser } from "../net/natfrp";
import { createOffline, listAccounts, removeAccount, setActiveAccount } from "../auth/accounts";
import { beginDeviceCode, pollDeviceCode } from "../auth/microsoft";
import { SOURCES, probeSources, setActiveSource } from "../core/sources";
import { listVersions } from "../minecraft/manifest";
import { createInstance, deleteInstance, listInstances, listSaves, setLoader, updateInstance } from "../minecraft/instances";
import { launchInstance } from "../minecraft/launch";
import { installLoader, listLoaderVersions } from "../loaders/index";
import { installJava, listInstalledJava, listJavaReleases } from "../java/index";
import { listMapEntries } from "../mods/minekuai";
import { checkUpdates, getModDependencies, getModDetail, installMod, installed, listInstalledMods, listCategories, listFilterOptions, listModFiles, remove as removeMod, searchMods, update as updateMod } from "../mods/index";
import {
  cancel as cancelDownloadJob, clearFinished as clearFinishedDownloads, hintNextJob, list as listDownloadJobs,
  remove as removeDownloadJob, resume as resumeDownloadJob, runCancellable,
} from "../downloads/index";

const handle = <T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void => {
  ipcMain.handle(channel, async (_event, ...args: any[]) => fn(...args));
};

const IMAGE_EXT = /.(png|jpe?g|webp|gif|bmp)$/i;
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

  // 自定义界面图标：选中的图标存在就返回 file:// 直链，否则 null
  handle<UpdateCheckResult>(IPC.appCheckUpdates, () => checkAppUpdates());

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
      backgrounds: await listFiles(dirs.backgrounds, IMAGE_EXT),
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
    setActiveSource(next.downloadSource);
    return next;
  });

  handle<Account[]>(IPC.accountsList, () => listAccounts());
  handle<Account>(IPC.accountsCreateOffline, (name: string) => createOffline(name));
  handle<void>(IPC.accountsRemove, (id: string) => removeAccount(id));
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

  handle(IPC.javaReleases, () => listJavaReleases());
  handle(IPC.javaInstalled, () => listInstalledJava());
  handle(IPC.javaInstall, (major: number, version: string) => {
    hintNextJob({ kind: "java", detail: `JDK ${major}`, resume: JSON.stringify({ major, version }) });
    return runCancellable((signal) => installJava(major, version, signal));
  });

  handle(IPC.modsSearch, (req: ModSearchRequest) => searchMods(req));
  handle<ModCategory[]>(IPC.modsCategories, (kind: ModContentKind, source: ModSourceFilter) => listCategories(kind, source));
  handle<ModFilterOptions>(IPC.modsFilterOptions, (kind: ModContentKind) => listFilterOptions(kind));
  handle<MapEntry[]>(IPC.modsMaps, (query: string, page: number, instanceId?: string) => listMapEntries(query, page, instanceId));
  handle<ModDetail>(IPC.modsDetail, (provider: ModProviderId, projectId: string) => getModDetail(provider, projectId));
  handle(IPC.modsFiles, (req: ModFilesRequest) => listModFiles(req));
  handle<ModInstallResult>(IPC.modsInstall, (req: ModInstallRequest) => {
    hintNextJob({ kind: "content", detail: req.instanceId, resume: JSON.stringify(req) });
    return runCancellable((signal) => installMod(req, signal));
  });
  handle<ModDependency[]>(IPC.modsDependencies, (provider: ModProviderId, projectId: string, instanceId: string, fileId?: string) => getModDependencies(provider, projectId, instanceId, fileId));
  handle<InstalledModInfo[]>(IPC.modsInstalled, (instanceId: string) => installed(instanceId));
  handle<InstalledModInfo[]>(IPC.modsCheckUpdates, (instanceId: string) => checkUpdates(instanceId));
  handle<void>(IPC.modsRemove, (instanceId: string, fileName: string) => removeMod(instanceId, fileName));
  handle<{ fileName: string; path: string }>(IPC.modsUpdate, (instanceId: string, fileName: string) => updateMod(instanceId, fileName));

  // 下载记录：持久化的安装任务列表，重启后可继续
  handle<DownloadJob[]>(IPC.downloadsList, () => listDownloadJobs());
  handle<void>(IPC.downloadsResume, (id: string) => resumeDownloadJob(id));
  handle<void>(IPC.downloadsCancel, (id: string) => cancelDownloadJob(id));
  handle<void>(IPC.downloadsRemove, (id: string) => removeDownloadJob(id));
  handle<void>(IPC.downloadsClearFinished, () => clearFinishedDownloads());
}
