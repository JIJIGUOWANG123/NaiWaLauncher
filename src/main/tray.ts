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

/** 应用真正退出时销毁托盘图标（「关闭到托盘」开关不再决定它存在与否）。 */
export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  log.info("已销毁托盘图标");
}

/** 当前是否真的有可用托盘（关闭窗口时据此决定能否隐藏）。 */
export function hasTray(): boolean {
  return tray !== null;
}

/**
 * 确保托盘图标存在并绑定窗口/退出回调，返回「调用结束后是否真的有可用托盘」。
 * 语义（用户要求）：图标常驻，与「关闭到托盘」开关无关 —— 那个开关只决定点 X 时
 * 是隐藏到托盘还是退出。所以这里没有「关掉开关就销毁图标」的分支；
 * 只有应用真正退出（quitting，由 before-quit 置位）时才不创建、并销毁。
 */
export function syncTray(getWindow: () => BrowserWindow | null, quit: () => void): boolean {
  if (quitting) {
    destroyTray();
    return false;
  }
  // 已经建过：菜单/回调是闭包，不必重建（设置变化时也只是走到这里）
  if (tray) return true;

  try {
    const source = nativeImage.createFromPath(trayIconPath());
    // Windows 通知区域按 16×16 显示：显式缩放，避免个别 DPI 下直接取到 256×256 时模糊/空白
    const scaled = source.isEmpty() ? source : source.resize({ width: 16, height: 16 });
    // resize 失败（个别 ico 编码）时退回原始图，宁可大一点也别没有图标
    const image = scaled.isEmpty() ? source : scaled;
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
    return true;
  } catch (err) {
    tray = null;
    log.warn("创建托盘失败（不影响使用）：" + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

/** 窗口被关闭时调用：开启「关闭到托盘」则拦下关闭改为隐藏，返回 true 表示已接管。 */
export function hideInsteadOfClose(getWindow: () => BrowserWindow | null, quit: () => void): boolean {
  if (quitting || !getSettings().closeToTray) return false;
  const win = getWindow();
  if (!win) return false;
  // 托盘不可用时绝不能 hide：藏起来就没有任何入口能把窗口叫回来了，退一步只最小化
  if (!syncTray(getWindow, quit)) {
    win.minimize();
    log.warn("托盘不可用，已改为最小化而不是隐藏");
    return false;
  }
  win.hide();
  log.info("已隐藏到托盘（设置：关闭到托盘）");
  return true;
}