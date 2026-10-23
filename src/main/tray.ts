// 系统托盘：只在设置里开启「关闭到托盘」时创建。
// 关闭窗口时不再退出程序（隐藏到托盘），右下角图标可用于重新打开界面或真正退出。
import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./core/logger";
import { getPaths } from "./core/paths";
import { getSettings } from "./core/settings";
import { logoPathFor } from "./splash";

const log = logger("tray");

let tray: Tray | null = null;
/** 真正退出时置位：close 处理器据此放行，而不是又藏回托盘。 */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

/** 托盘图标：优先用打包进 resources 的 ico（Windows 托盘对 ico 支持最好）。 */
function trayIconPath(): string {
  const packaged = join(process.resourcesPath ?? "", "logo.ico");
  if (process.resourcesPath && existsSync(packaged)) return packaged;
  const dev = join(getPaths().root, "resources", "logo.ico");
  if (existsSync(dev)) return dev;
  return logoPathFor(getPaths().root, app.isPackaged);
}

function showWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * 按当前设置同步托盘：开启就建、关闭就销毁。
 * 设置改变时也调用它，避免「设置关了图标还在」。
 */
export function syncTray(getWindow: () => BrowserWindow | null, quit: () => void): void {
  const enabled = getSettings().closeToTray;
  if (!enabled) {
    if (tray) {
      tray.destroy();
      tray = null;
      log.info("已按设置移除托盘图标");
    }
    return;
  }
  if (tray) return;

  try {
    const image = nativeImage.createFromPath(trayIconPath());
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip("奶娃启动器 NaiWa Launcher");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开界面", click: () => showWindow(getWindow) },
        { type: "separator" },
        {
          label: "退出启动器",
          click: () => {
            markQuitting();
            quit();
          },
        },
      ]),
    );
    // 单击/双击都回到界面（Windows 习惯是双击，但单击更省事，两个都接）
    tray.on("click", () => showWindow(getWindow));
    tray.on("double-click", () => showWindow(getWindow));
    log.info("已创建托盘图标：" + trayIconPath());
  } catch (err) {
    tray = null;
    log.warn("创建托盘失败（不影响使用）：" + (err instanceof Error ? err.message : String(err)));
  }
}

/** 窗口被关闭时调用：开启「关闭到托盘」则拦下关闭改为隐藏，返回 true 表示已接管。 */
export function hideInsteadOfClose(getWindow: () => BrowserWindow | null, quit: () => void): boolean {
  if (quitting || !getSettings().closeToTray) return false;
  const win = getWindow();
  if (!win) return false;
  syncTray(getWindow, quit);
  win.hide();
  log.info("已隐藏到托盘（设置：关闭到托盘）");
  return true;
}