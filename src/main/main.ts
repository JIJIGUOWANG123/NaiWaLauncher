import { perfMark } from "./core/perf";
import { app, BrowserWindow, dialog, net, Notification, shell } from "electron";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { getPaths } from "./core/paths";
import { ensureDirs, initPaths } from "./core/paths";
import { getSettings, loadSettings, peekShowSplash, updateSettings } from "./core/settings";
import { setEventSink } from "./core/events";
import { load as loadDownloadJobs, setChangedSink as setDownloadsChangedSink, trackProgress, trackResult } from "./downloads/index";
import { setLogSink, logger } from "./core/logger";
import { setActiveSource } from "./core/sources";
import { setSystemFetcher } from "./core/netfetch";
import { registerIpc } from "./ipc/register";
import { checkAppUpdates } from "./core/updates";
import type { Settings, UpdateCheckResult } from "../shared/types";
import { createSplash, fadeInWindow, fadeOutSplash, logoPathFor, splashHoldRemaining } from "./splash";
import { destroyTray, hasTray, isQuitting, markQuitting, syncTray } from "./tray";
import { stopSkinApi } from "./skins/localapi";
import { mt } from "./core/i18n";

let mainWindow: BrowserWindow | null = null;
const log = logger("main");

/**
 * 固定应用身份（AppUserModelID）。Windows 按「exe 路径 + AUMID」识别一个应用：
 * 0.2.x 把 exe 从 <root>\NaiWa Launcher.exe 挪到了 <root>\main\NaiWa Launcher.exe，
 * 没有 AUMID 时新路径会被当成另一个应用 —— 用户之前设过的通知区域「显示/溢出」偏好
 * 与任务栏分组都会失效，托盘图标默认被收进溢出区。
 * 显式指定后路径变了身份不变，偏好与分组沿用。
 */
const APP_USER_MODEL_ID = "Naiwa.Launcher";

// 模块载入：main.ts 的 import 全部求值完的时刻，作为启动计时的第一个锚点
perfMark("main-module-loaded");

// 越早越好：必须早于任何窗口/Tray 创建（第二个实例也设一次，代价可忽略）
app.setAppUserModelId(APP_USER_MODEL_ID);

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

  // 关闭策略由 settings.closeAction 决定：tray=隐藏到托盘、quit=直接退出、ask=弹窗询问
  win.on("close", (event) => {
    // 真正退出（托盘菜单 / app.quit / 系统退出）时一律放行，别拦
    if (isQuitting()) return;
    const action = effectiveCloseAction();
    if (action === "quit") return; // 让窗口正常关闭，随后的 window-all-closed 会退出进程
    event.preventDefault();
    if (action === "tray") {
      hideToTray(win);
      return;
    }
    // ask：弹窗期间不能重复弹（异步，窗口可能被连点）
    void askCloseAction(win);
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

type CloseAction = "ask" | "tray" | "quit";

/** 询问弹窗是否正在显示：防止连点关闭弹出多个对话框。 */
let closePromptOpen = false;

/**
 * 实际生效的关闭策略。
 * 兼容老配置：closeAction 还是默认的 "ask"、但用户以前勾过「关闭到托盘」（closeToTray=true）时，
 * 直接按 tray 处理 —— 老用户的选择已经表达过，不该因为升级再被问一遍。
 */
function effectiveCloseAction(): CloseAction {
  const settings = getSettings();
  if (settings.closeAction !== "ask") return settings.closeAction;
  return settings.closeToTray ? "tray" : "ask";
}

/** 隐藏到托盘；托盘不可用时改为最小化并 warn（绝不能把窗口藏丢）。 */
function hideToTray(win: BrowserWindow): boolean {
  if (!syncTray(() => mainWindow, () => quitApp())) {
    win.minimize();
    log.warn("托盘不可用，已改为最小化而不是隐藏");
    return false;
  }
  win.hide();
  log.info("已隐藏到托盘（closeAction=tray）");
  return true;
}

/**
 * 首次关闭询问：最小化到托盘 / 直接退出 / 取消。
 * 勾了「记住我的选择」才写设置；取消则什么都不做（窗口保留）。
 */
async function askCloseAction(win: BrowserWindow): Promise<void> {
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(win, {
      type: "question",
      title: mt("main.closeTitle"),
      message: mt("main.closeMessage"),
      detail: mt("main.closeDetail"),
      buttons: [mt("main.minimizeToTray"), mt("main.quitNow"), mt("common.cancel")],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: mt("main.rememberChoice"),
      checkboxChecked: false,
      noLink: true,
    });
    // 取消：什么都不做，窗口保留
    if (result.response === 2) {
      log.info("关闭询问：用户选择取消");
      return;
    }
    const remember = result.checkboxChecked === true;
    if (result.response === 0) {
      if (!hideToTray(win)) return;
      if (remember) await updateSettings({ closeAction: "tray", closeToTray: true });
      log.info("关闭询问：最小化到托盘" + (remember ? "（已记住）" : ""));
      return;
    }
    if (remember) await updateSettings({ closeAction: "quit", closeToTray: false });
    log.info("关闭询问：直接退出" + (remember ? "（已记住）" : ""));
    quitApp();
  } catch (err) {
    // 弹窗失败（极少见）：保持窗口打开，别把用户的东西弄丢
    log.warn("关闭询问失败，保持窗口：" + (err instanceof Error ? err.message : String(err)));
  } finally {
    closePromptOpen = false;
  }
}

/**
 * 自动更新检查的延迟：窗口出来之后再等 6 秒。
 * 6s 落在需求给的 5–8s 区间里，也避开了首帧、背景图、版本清单那几轮 IPC 的高峰。
 */
const AUTO_UPDATE_DELAY_MS = 6000;

/**
 * 「自动更新」的提示：用系统通知，不弹阻塞式对话框 ——
 * 用户可能正在进游戏，任何挡住窗口的弹窗都是干扰。
 */
function notifyUpdateAvailable(result: UpdateCheckResult): void {
  if (!Notification.isSupported()) {
    log.warn("系统通知不可用，跳过新版本提示（版本 " + result.latest + "）");
    return;
  }
  const notice = new Notification({
    title: mt("main.updateAvailableTitle"),
    body: mt("main.updateAvailableBody", { latest: result.latest ?? "", current: result.current }),
    silent: true,
  });
  // 点通知把窗口叫到前台，更新入口在「关于」页
  notice.on("click", () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
  notice.show();
}

/**
 * 启动完成后的自动检查（只在 updateMode === "auto" 时跑）。
 * 定时器不 await、不挡住启动流程；手动模式下这里直接返回，什么也不做，
 * 于是「只有用户点检查更新才查」的原有行为保持不变。
 */
function scheduleAutoUpdateCheck(): void {
  setTimeout(() => {
    if (getSettings().updateMode !== "auto") return;
    void (async () => {
      try {
        const result = await checkAppUpdates();
        log.info("[updates] 自动检查：" + (result.hasUpdate ? "发现新版本 " + result.latest : "已是最新"));
        if (result.hasUpdate) notifyUpdateAvailable(result);
      } catch (err) {
        // 自动检查失败静默：用户到「关于」页手动检查时才会看到错误
        log.warn("[updates] 自动检查失败：" + (err instanceof Error ? err.message : String(err)));
      }
    })();
  }, AUTO_UPDATE_DELAY_MS);
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
    title: mt("main.alreadyRunningTitle"),
    message: mt("main.alreadyRunningMessage"),
    buttons: [mt("main.gotIt")],
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
    // 自动更新检查（updateMode=auto 才查）：延迟 6 秒、后台跑，绝不阻塞启动
    scheduleAutoUpdateCheck();

    app.on("before-quit", () => { markQuitting(); });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(getSettings());
        mainWindow.once("ready-to-show", () => void fadeInWindow(mainWindow!));
      }
    });
  });

  app.on("window-all-closed", () => {
    // closeAction=quit：窗口关掉就该退出；tray/ask 才可能留在后台，而且托盘必须真的可用，
    // 否则用户再也叫不回窗口（安全网）。
    const settings = getSettings();
    const keepAlive = settings.closeAction !== "quit" && settings.closeToTray && hasTray();
    if (keepAlive) return;
    if (process.platform !== "darwin") quitApp();
  });

  // 本地皮肤 API 只在离线账号启动游戏时用：进程退出前关掉，别把 127.0.0.1 上的端口留着
  app.on("will-quit", () => {
    void stopSkinApi();
    // 托盘图标常驻，只有真正退出时才销毁
    destroyTray();
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
