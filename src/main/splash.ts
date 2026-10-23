import { BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { perfMark } from "./core/perf";

const SPLASH_WIDTH = 460;
const SPLASH_HEIGHT = 460;

function splashHtml(logoDataUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
    html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-app-region:drag}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
      font-family:"Segoe UI",system-ui,sans-serif;animation:wrapIn .45s ease-out both}
    .logo{width:200px;height:200px;filter:drop-shadow(0 18px 34px rgba(0,0,0,.55));
      animation:logoIn .75s cubic-bezier(.2,.9,.25,1) both}
    .zh{margin-top:14px;font-size:20px;letter-spacing:6px;color:#F6D365;
      animation:fadeUp .6s .25s ease-out both;text-shadow:0 2px 12px rgba(0,0,0,.5)}
    .en{margin-top:2px;font-size:11px;letter-spacing:3.6px;color:rgba(245,232,206,.62);text-transform:uppercase;
      animation:fadeUp .6s .4s ease-out both}
    .bar{margin-top:20px;width:132px;height:3px;border-radius:3px;background:rgba(246,211,101,.16);overflow:hidden}
    .bar i{display:block;height:100%;width:40%;border-radius:3px;background:linear-gradient(90deg,#F6D365,#E0A93B);
      animation:slide 1.25s ease-in-out infinite}
    @keyframes wrapIn{from{opacity:0}to{opacity:1}}
    @keyframes logoIn{from{opacity:0;transform:translateY(14px) scale(.9)}to{opacity:1;transform:none}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes slide{0%{transform:translateX(-115%)}100%{transform:translateX(255%)}}
    .out{animation:wrapOut .42s ease-in forwards}
    @keyframes wrapOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.985)}}
  </style></head><body><div class="wrap" id="wrap">
    <img class="logo" src="${logoDataUrl}" alt="NaiWa Launcher"/>
    <div class="zh">奶娃启动器</div>
    <div class="en">NaiWa Launcher</div>
    <div class="bar"><i></i></div>
  </div></body></html>`;
}

/**
 * 启动画面的最小可见时长：容器入场 .45s + logo 动画 .75s + 约 .25s 停留。
 * 低于这个值动画会被切断，观感变差；高于这个值就是在无谓等待。
 */
export const SPLASH_MIN_VISIBLE_MS = 1250;

/**
 * 交棒前还要等多久（毫秒）。原先固定等 1500ms，与启动画面自己出现多久无关，恒定多付一笔；
 * 这里按「启动画面从创建到现在过了多久」补差值：窗口就绪得越慢就等得越少，
 * 但总可见时长永远不低于 SPLASH_MIN_VISIBLE_MS。
 */
export function splashHoldRemaining(startedAt: number): number {
  return Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - startedAt));
}

export function createSplash(logoPath: string): BrowserWindow {
  const dataUrl = `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`;
  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHtml(dataUrl)));
  return win;
}

/** 淡出 splash：先播放收尾动画，再线性降低窗口透明度。 */
export async function fadeOutSplash(win: BrowserWindow | null, durationMs = 520): Promise<void> {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript("document.getElementById('wrap')?.classList.add('out')");
  } catch {
    /* 页面已销毁时忽略 */
  }
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    if (win.isDestroyed()) return;
    win.setOpacity(1 - i / steps);
    await new Promise((r) => setTimeout(r, Math.max(16, Math.round(durationMs / steps))));
  }
  if (!win.isDestroyed()) win.destroy();
}

/** 主窗口淡入，避免和 splash 交接时白闪。 */
export async function fadeInWindow(win: BrowserWindow, durationMs = 260): Promise<void> {
  if (win.isDestroyed()) return;
  win.setOpacity(0);
  win.show();
  // 用户真正看到界面的时刻（ready-to-show 之后还要等 splash 补时 + 淡入）
  perfMark("window-shown");
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    if (win.isDestroyed()) return;
    win.setOpacity(i / steps);
    await new Promise((r) => setTimeout(r, Math.max(12, Math.round(durationMs / steps))));
  }
  if (!win.isDestroyed()) win.setOpacity(1);
}

export function logoPathFor(rootDir: string, isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "logo-512.png")
    : join(rootDir, "resources", "logo-512.png");
}
