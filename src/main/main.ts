import { perfMark } from "./core/perf";
import { app, BrowserWindow, dialog, net, shell } from "electron";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { getPaths } from "./core/paths";
import { ensureDirs, initPaths } from "./core/paths";
import { getSettings, loadSettings, peekShowSplash } from "./core/settings";
import { setEventSink } from "./core/events";
import { load as loadDownloadJobs, setChangedSink as setDownloadsChangedSink, trackProgress, trackResult } from "./downloads/index";
import { setLogSink, logger } from "./core/logger";
import { setActiveSource } from "./core/sources";
import { setSystemFetcher } from "./core/netfetch";
import { registerIpc } from "./ipc/register";
import type { Settings } from "../shared/types";
import { createSplash, fadeInWindow, fadeOutSplash, logoPathFor, splashHoldRemaining } from "./splash";
import { hideInsteadOfClose, markQuitting, syncTray } from "./tray";
import { stopSkinApi } from "./skins/localapi";

let mainWindow: BrowserWindow | null = null;
const log = logger("main");

// 模块载入：main.ts 的 import 全部求值完的时刻，作为启动计时的第一个锚点
perfMark("main-module-loaded");

function rootDir(): string {
  // 三种形态共用同一套便携布局（数据与程序同级）：
  // 1) 单文件便携 exe：electron-builder 把原始目录注入 PORTABLE_EXECUTABLE_DIR；
  // 2) 常规打包：exe 同级目录；
  // 3) 开发态：项目根目录。NAIWA_ROOT 仅供调试/冒烟测试覆盖。
  if (process.env.NAIWA_ROOT) return process.env.NAIWA_ROOT;
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) return portable;
  if (app.isPackaged) {
    // 安装版把 Electron 运行时收在 <root>\main（旧版是 .runtime）里，程序文件与数据分离：
    // 根目录放 NaiWa Launcher.exe（引导壳）、.minecraft、NaiWa、servers 等数据
    const exeDir = join(process.execPath, "..");
    const sub = basename(exeDir).toLowerCase();
    return sub === "main" || sub === ".runtime" ? join(exeDir, "..") : exeDir;
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
      // 窗口在 ready-to-show 之前是隐藏的：默认节流会把渲染进程早期的一次性任务（含 React 的首帧
      // 后续 effect）压到秒级之后。实测本机隐藏期首屏 effect 被推迟 ~5.8s，关掉后回到 ~40ms。
      backgroundThrottling: false,
    },
  });
  // 自定义界面图标同时应用到窗口/任务栏（Windows 支持运行时 setIcon）
  const customIcon = settings.appIcon ? join(getPaths().dataRoot, "icons", settings.appIcon) : "";
  if (customIcon && existsSync(customIcon)) win.setIcon(customIcon);

  // 「关闭到托盘」：拦下真正的关闭，改成隐藏窗口；真正退出时（托盘菜单 / 系统退出）放行
  win.on("close", (event) => {
    if (!hideInsteadOfClose(() => mainWindow, () => quitApp())) return;
    event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // 渲染层的 perf 打点（console.info）转发进主进程日志：启动耗时的全部数据统一落在 NaiWa/logs 里
  win.webContents.on("console-message", (details, _level, message) => {
    const text = typeof message === "string" && message !== "" ? message : details.message;
    if (text.startsWith("perf:")) log.info(text);
  });
  win.webContents.on("did-finish-load", () => { perfMark("did-finish-load"); });
  const devUrl = process.env.NAIWA_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../../dist/renderer/index.html"));
  return win;
}

/** 真正退出：置 quitting 让 close 处理器放行，再走正常退出流程（服务端由 before-quit 停掉）。 */
function quitApp(): void {
  markQuitting();
  app.quit();
}

async function bootstrap(): Promise<void> {
  const root = rootDir();
  // 建目录与读设置互不依赖（设置读的是文件，目录不存在也只是读不到），并行等更省一趟往返
  const [, settings] = await Promise.all([ensureDirs(), loadSettings()]);
  setActiveSource(settings.downloadSource);
  registerIpc();
  log.info(`启动 NaiWa Launcher，根目录 ${root}`);
}

/**
 * 单实例锁：必须在任何初始化之前拿到。拿不到说明已经有一个启动器在跑，
 * 第二个进程只负责退出，把「切回原窗口」交给已运行实例的 second-instance。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

/** 把已有窗口叫到前台：托盘隐藏（isVisible=false）时也要能唤回，与托盘菜单同一套做法。 */
function bringToFront(): void {
  const win = mainWindow;
  // 窗口还没建好（双击得太快）：不弹窗也不报错，交给已运行的实例自己处理
  if (!win || win.isDestroyed()) {
    log.info("收到第二次启动请求，但主窗口尚未创建，忽略");
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  // 不 await：second-instance 里阻塞会让第二次启动的进程一直挂在那里
  void dialog.showMessageBox(win, {
    type: "info",
    title: "已经有一个在运行",
    message: "奶娃启动器已经在运行，已为你切回原窗口。",
    buttons: ["知道了"],
  });
}

/** 全部初始化（读设置、注册 IPC、建窗口）。拿不到单实例锁时一个都不执行。 */
function startApp(): void {
  app.whenReady().then(async () => {
    perfMark("app-ready");
    // 登录请求改走 Chromium 网络栈：系统代理与 Windows 证书库都生效（Node 自带 fetch 两者都不吃）
    setSystemFetcher((input, init) => net.fetch(input, init as never) as unknown as Promise<Response>);
    const root = rootDir();
    // 路径必须先就位：loadSettings 要读 <dataRoot>/config/settings.json。
    // 之前 initPaths 在 bootstrap 里，whenReady 的第一次 loadSettings 撞上「paths not initialised」
    // 被 catch 静默吞掉、回落默认值 —— 于是 showSplash 从来没按设置生效，还白读了一遍设置文件。
    initPaths(root);
    // 启动画面要在任何 await 之前出来：它只是「用户双击后能否马上看到反应」的关键一步。
    // 是否显示由同步预读决定（设置文件很小），完整设置稍后照常异步加载。
    const splashStartedAt = Date.now();
    const splash = peekShowSplash() ? createSplash(logoPathFor(root, app.isPackaged)) : null;
    perfMark("splash-created");
    const bootSettings = await loadSettings();
    await bootstrap();
    perfMark("bootstrap-done");

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
    perfMark("window-created");
    // 下载记录只服务「管理」页列表：窗口已经开始加载再读盘，不占启动路径。
    // 残留的 running 记录照样在这里改判为中断（IPC 读记录时会等这一次读盘完成，界面不会看到空列表）。
    void loadDownloadJobs().then(() => { perfMark("downloads-restored"); });
    mainWindow.once("ready-to-show", async () => {
      perfMark("ready-to-show");
      // 让 logo 完整露出（淡入 .75s + 停留），再渐变消失交棒给主窗口。
      // 等待时长按启动画面已经露出的时间补差，而不是恒定等满 1500ms。
      if (!splash) { void fadeInWindow(mainWindow!); return; }
      const hold = splashHoldRemaining(splashStartedAt);
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      await fadeInWindow(mainWindow!);
      await fadeOutSplash(splash);
    });
    mainWindow.on("closed", () => { mainWindow = null; });
    // 启动时按设置决定有没有托盘图标（关掉设置的用户不会看到多余图标）
    syncTray(() => mainWindow, () => quitApp());

    app.on("before-quit", () => { markQuitting(); });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(getSettings());
        mainWindow.once("ready-to-show", () => void fadeInWindow(mainWindow!));
      }
    });
  });

  app.on("window-all-closed", () => {
    // 开了「关闭到托盘」时窗口只是隐藏，不该因为「没有窗口」就退出
    if (getSettings().closeToTray) return;
    if (process.platform !== "darwin") quitApp();
  });

  // 本地皮肤 API 只在离线账号启动游戏时用：进程退出前关掉，别把 127.0.0.1 上的端口留着
  app.on("will-quit", () => {
    void stopSkinApi();
  });
}

if (!hasSingleInstanceLock) {
  // 已有实例在运行：立刻退出，不建窗口、不读设置、不注册 IPC
  app.quit();
} else {
  app.on("second-instance", () => {
    bringToFront();
  });
  startApp();
}
