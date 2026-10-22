import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { NaiwaApi } from "../shared/ipc";
import type { DownloadJob, LogLine, MediaList, TaskProgress, TaskResult } from "../shared/types";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

const api: NaiwaApi = {
  app: {
    info: () => invoke(IPC.appInfo),
    openRootDir: () => invoke(IPC.openRootDir),
    openPath: (path) => invoke(IPC.openPath, path),
    copyText: (text) => invoke(IPC.copyText, text),
    pathExists: (path) => invoke(IPC.pathExists, path),
    startupSound: () => invoke(IPC.startupSound),
    appIcon: () => invoke(IPC.appIcon),
    checkUpdates: () => invoke(IPC.appCheckUpdates),
    installUpdate: (url) => invoke(IPC.appInstallUpdate, url),
    revealInFolder: (path) => invoke(IPC.appReveal, path),
    openInstanceMods: (instanceId) => invoke(IPC.openInstanceMods, instanceId),
    openExternal: (url) => invoke(IPC.openExternal, url),
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
  },
  media: {
    list: () => invoke(IPC.mediaList),
    openDir: async (kind) => {
      const media = await invoke<MediaList>(IPC.mediaList);
      const dir = kind === "backgrounds" ? media.dirs.backgrounds : kind === "icons" ? media.dirs.icons : media.dirs.music;
      await invoke(IPC.openPath, dir);
    },
  },
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: () => invoke(IPC.windowIsMaximized),
  },
  net: {
    interfaces: () => invoke(IPC.netInterfaces),
    probe: (host, port) => invoke(IPC.netProbe, host, port),
    portCheck: (port) => invoke(IPC.netPortCheck, port),
    natfrpUser: () => invoke(IPC.natfrpUser),
    natfrpTunnels: () => invoke(IPC.natfrpTunnels),
    natfrpNodes: () => invoke(IPC.natfrpNodes),
    natfrpCreate: (name, node, localPort) => invoke(IPC.natfrpCreate, name, node, localPort),
    natfrpStatus: () => invoke(IPC.natfrpStatus),
    natfrpStart: (tunnelId) => invoke(IPC.natfrpStart, tunnelId),
    natfrpStop: () => invoke(IPC.natfrpStop),
  },
  sources: {
    list: () => invoke(IPC.sourcesList),
    probe: () => invoke(IPC.sourcesProbe),
    set: (id) => invoke(IPC.sourcesSet, id),
  },
  accounts: {
    list: () => invoke(IPC.accountsList),
    createOffline: (name) => invoke(IPC.accountsCreateOffline, name),
    remove: (id) => invoke(IPC.accountsRemove, id),
    setActive: (id) => invoke(IPC.accountsSetActive, id),
    loginYggdrasil: (apiUrl, username, password) => invoke(IPC.accountsLoginYggdrasil, apiUrl, username, password),
    validateYggdrasil: (id) => invoke(IPC.accountsValidateYggdrasil, id),
    skin: (id) => invoke(IPC.skinsGet, id),
    pickSkinFile: () => invoke(IPC.skinsPickFile),
    uploadSkin: (id, filePath, model) => invoke(IPC.skinsUpload, id, filePath, model),
    resetSkin: (id) => invoke(IPC.skinsReset, id),
    beginMicrosoft: () => invoke(IPC.accountsBeginMicrosoft),
    pollMicrosoft: (deviceCode) => invoke(IPC.accountsPollMicrosoft, deviceCode),
  },
  versions: {
    list: (force) => invoke(IPC.versionsList, force ?? false),
    loaders: (mcVersion, loader) => invoke(IPC.loadersList, mcVersion, loader),
  },
  instances: {
    list: () => invoke(IPC.instancesList),
    create: (req) => invoke(IPC.instancesCreate, req),
    update: (id, patch) => invoke(IPC.instancesUpdate, id, patch),
    remove: (id) => invoke(IPC.instancesDelete, id),
    launch: (id, quickPlayLevel) => invoke(IPC.instancesLaunch, id, quickPlayLevel),
    saves: (id) => invoke(IPC.instancesSaves, id),
    exportArchive: (id) => invoke(IPC.instancesExport, id),
    importArchive: () => invoke(IPC.instancesImport),
    setLoader: (id, loader, loaderVersion) => invoke(IPC.instancesSetLoader, id, loader, loaderVersion),
  },
  java: {
    releases: () => invoke(IPC.javaReleases),
    installed: () => invoke(IPC.javaInstalled),
    install: (major, version) => invoke(IPC.javaInstall, major, version),
  },
  mods: {
    search: (req) => invoke(IPC.modsSearch, req),
    detail: (provider, projectId) => invoke(IPC.modsDetail, provider, projectId),
    files: (req) => invoke(IPC.modsFiles, req),
    install: (req) => invoke(IPC.modsInstall, req),
    dependencies: (provider, projectId, instanceId, fileId) => invoke(IPC.modsDependencies, provider, projectId, instanceId, fileId),
    maps: (query, page, instanceId) => invoke(IPC.modsMaps, query, page, instanceId),
    categories: (kind, source) => invoke(IPC.modsCategories, kind, source),
    installModpack: (provider, projectId, fileId, instanceName) => invoke(IPC.modsInstallModpack, provider, projectId, fileId, instanceName),
    filterOptions: (kind) => invoke(IPC.modsFilterOptions, kind),
    installed: (instanceId) => invoke(IPC.modsInstalled, instanceId),
    checkUpdates: (instanceId) => invoke(IPC.modsCheckUpdates, instanceId),
    remove: (instanceId, fileName) => invoke(IPC.modsRemove, instanceId, fileName),
    update: (instanceId, fileName) => invoke(IPC.modsUpdate, instanceId, fileName),
  },
  downloads: {
    list: () => invoke(IPC.downloadsList),
    resume: (id) => invoke(IPC.downloadsResume, id),
    cancel: (id) => invoke(IPC.downloadsCancel, id),
    remove: (id) => invoke(IPC.downloadsRemove, id),
    clearFinished: () => invoke(IPC.downloadsClearFinished),
    onChanged: (cb) => { const h = (_: unknown, jobs: DownloadJob[]) => cb(jobs); ipcRenderer.on(IPC.downloadsChanged, h); return () => ipcRenderer.off(IPC.downloadsChanged, h); },
  },
  events: {
    onProgress: (cb) => { const h = (_: unknown, p: TaskProgress) => cb(p); ipcRenderer.on("task:progress", h); return () => ipcRenderer.off("task:progress", h); },
    onTaskDone: (cb) => { const h = (_: unknown, r: TaskResult) => cb(r); ipcRenderer.on("task:done", h); return () => ipcRenderer.off("task:done", h); },
    onLog: (cb) => { const h = (_: unknown, l: LogLine) => cb(l); ipcRenderer.on("app:log", h); return () => ipcRenderer.off("app:log", h); },
  },
};

contextBridge.exposeInMainWorld("naiwa", api);
