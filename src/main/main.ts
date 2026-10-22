import { app, BrowserWindow, shell } from "electron";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { getPaths } from "./core/paths";
import { ensureDirs, initPaths } from "./core/paths";
import { getSettings, loadSettings } from "./core/settings";
import { setEventSink } from "./core/events";
import { load as loadDownloadJobs, setChangedSink as setDownloadsChangedSink, trackProgress, trackResult } from "./downloads/index";
import { setLogSink, logger } from "./core/logger";
import { setActiveSource } from "./core/sources";
import { registerIpc } from "./ipc/register";
import type { Settings } from "../shared/types";
import { createSplash, fadeInWindow, fadeOutSplash, logoPathFor } from "./splash";

let mainWindow: BrowserWindow | null = null;
const log = logger("main");

function rootDir(): string {
  // 三种形态共用同一套便携布局（数据与程序同级）：
  // 1) 单文件便携 exe：electron-builder 把原始目录注入 PORTABLE_EXECUTABLE_DIR；
  // 2) 常规打包：exe 同级目录；
  // 3) 开发态：项目根目录。NAIWA_ROOT 仅供调试/冒烟测试覆盖。
  if (process.env.NAIWA_ROOT) return process.env.NAIWA_ROOT;
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) return portable;
  if (app.isPackaged) {
    // 安装版把 Electron 运行时收在 <root>\.runtime 里，根目录取其父，保持根目录干净
    const exeDir = join(process.execPath, "..");
    return basename(exeDir) === ".runtime" ? join(exeDir, "..") : exeDir;
  }
  return app.getAppPath();
}

function createMainWindow(settings: Settings): BrowserWindow {
  // 系统标题栏已移除：窗口始终无边框，渲染进程自绘标题栏（compact / image 两种外观）
  const frameless = true;
  const win = new BrowserWindow({
    width: 1280,
    height: 830,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#16120E",
    title: "NaiWa Launcher",
    icon: logoPathFor(rootDir(), app.isPackaged),
    autoHideMenuBar: true,
    frame: !frameless,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 自定义界面图标同时应用到窗口/任务栏（Windows 支持运行时 setIcon）
  const customIcon = settings.appIcon ? join(getPaths().dataRoot, "icons", settings.appIcon) : "";
  if (customIcon && existsSync(customIcon)) win.setIcon(customIcon);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env.NAIWA_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../../dist/renderer/index.html"));
  return win;
}

async function bootstrap(): Promise<void> {
  const root = rootDir();
  initPaths(root);
  await ensureDirs();
  const settings = await loadSettings();
  setActiveSource(settings.downloadSource);
  // 下载记录要在窗口起来之前读入：上次被强杀时残留的 running 记录会在这里改判为中断
  await loadDownloadJobs();
  registerIpc();
  log.info(`启动 NaiWa Launcher，根目录 ${root}`);
}

app.whenReady().then(async () => {
  const bootSettings = await loadSettings();
  const splash = bootSettings.showSplash ? createSplash(logoPathFor(rootDir(), app.isPackaged)) : null;
  await bootstrap();

  setLogSink((line) => mainWindow?.webContents.send("app:log", line));
  // 进度事件同时落进下载记录（断点续传靠它），并把记录变更推给界面
  setDownloadsChangedSink((jobs) => mainWindow?.webContents.send("downloads:changed", jobs));
  setEventSink({
    progress: (p) => {
      mainWindow?.webContents.send("task:progress", p);
      trackProgress(p);
    },
    done: (r) => {
      mainWindow?.webContents.send("task:done", r);
      trackResult(r);
    },
  });

  mainWindow = createMainWindow(getSettings());
  mainWindow.once("ready-to-show", async () => {
    // 让 logo 完整露出（淡入 .75s + 停留），再渐变消失交棒给主窗口。
    if (!splash) { void fadeInWindow(mainWindow!); return; }
    await new Promise((r) => setTimeout(r, 1500));
    await fadeInWindow(mainWindow!);
    await fadeOutSplash(splash);
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(getSettings());
      mainWindow.once("ready-to-show", () => void fadeInWindow(mainWindow!));
    }
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
