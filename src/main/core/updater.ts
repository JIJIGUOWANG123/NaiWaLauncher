import { app } from "electron";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { downloadFile } from "./http";
import { getPaths } from "./paths";
import { logger } from "./logger";

const log = logger("updater");

/** 免安装版文件名（仓库 Release 里就叫这个，不带版本号）。 */
export const SINGLE_EXE_NAME = "NaiWaLauncher.exe";

/**
 * 真正需要被替换的 exe：
 * portable 版是自解压 stub，运行时进程的 exe 在 %TEMP% 里，替换它等于没更新；
 * electron-builder 会把原始 exe 路径放在 PORTABLE_EXECUTABLE_FILE 环境变量里，优先用它。
 */
export function updateTarget(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && portable.toLowerCase().endsWith(".exe")) return portable;
  return app.getPath("exe");
}

/** 判断当前运行的是否为免安装版（安装版在 Program Files，需要管理员权限，不做自替换）。 */
export function canSelfUpdate(): boolean {
  const target = updateTarget();
  const lowered = target.toLowerCase();
  if (lowered.includes("program files") || lowered.includes("appdata\\local\\programs")) return false;
  // 运行目录在 %TEMP% 且没有 PORTABLE_EXECUTABLE_FILE，说明是解压后的副本，替换它没有意义
  const temp = tmpdir().toLowerCase();
  if (lowered.startsWith(temp) && !process.env.PORTABLE_EXECUTABLE_FILE) return false;
  return true;
}

/** 生成候选下载地址：官方直链 → gh-proxy 镜像 → ghproxy.net 镜像。 */
function downloadCandidates(url: string): string[] {
  const list = [url];
  if (/^https?:\/\/github\.com\//i.test(url)) {
    list.push(`https://ghproxy.sakuramoe.dev/${url}`, `https://gh-proxy.com/${url}`, `https://ghproxy.net/${url}`);
  }
  return list;
}

/** 下载新版本到 NaiWa/update，返回文件路径；直连失败会自动换镜像。 */
async function downloadToStaging(url: string): Promise<string> {
  const dir = join(getPaths().dataRoot, "update");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, SINGLE_EXE_NAME);
  let lastError = "";
  for (const candidate of downloadCandidates(url)) {
    await rm(dest, { force: true });
    try {
      log.info(`[updater] 下载更新包：${candidate}`);
      await downloadFile(candidate, dest, { label: "更新启动器", connections: 4 });
      const size = (await readFile(dest)).byteLength;
      if (size < 20 * 1024 * 1024) throw new Error(`更新包大小异常（${size} 字节）`);
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`[updater] 该地址下载失败（${candidate}）：${lastError}`);
    }
  }
  throw new Error(`更新包下载失败：${lastError || "网络不可用"}。若一直失败，请点「前往下载」用浏览器手动下载。`);
}


/**
 * 替换脚本正文（纯函数，便于自检断言）：等主进程退出后覆盖 exe，再拉起新版，最后自删。
 * 这里用 start "" 直接拉起，不用 start /min —— /min 需要一个可见的控制台窗口来承载。
 */
export function swapScriptBody(staged: string, target: string, scriptPath: string): string {
  return [
    "@echo off",
    // 用 ping 当 sleep：脚本以无控制台方式（stdio: ignore）启动，timeout 会因「输入重定向」直接失败
    "ping -n 3 127.0.0.1 >nul",
    ":retry",
    `move /y "${staged}" "${target}" >nul 2>&1`,
    "if errorlevel 1 (",
    "  ping -n 2 127.0.0.1 >nul",
    "  goto retry",
    ")",
    `start "" "${target}"`,
    `del "${scriptPath}" >nul 2>&1`,
  ].join("\r\n");
}

/** 生成替换脚本（正文见 swapScriptBody）。 */
async function writeSwapScript(staged: string, target: string): Promise<string> {
  const script = join(tmpdir(), `naiwa-update-${Date.now()}.cmd`);
  await writeFile(script, swapScriptBody(staged, target, script), "utf8");
  return script;
}

/** 启动参数记录：抽成纯函数，自检可以断言「命令行里没有任何 /min、windowsHide 已开」。 */
export interface UpdateLaunch {
  command: string;
  args: string[];
  options: { detached: boolean; stdio: "ignore"; windowsHide: boolean };
}

/**
 * 如何启动替换脚本：cmd /c <script>（不是 start /min <script>）。
 * detached + stdio:ignore + windowsHide 让 cmd 以无窗口方式运行，脚本内部再 start "" 拉起新版。
 */
export function updateLaunch(script: string): UpdateLaunch {
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/c", script],
    options: { detached: true, stdio: "ignore", windowsHide: true },
  };
}

/** 下载并应用更新：成功后启动脚本替换自身并退出，进程由新版接管。 */
export async function installUpdate(url: string): Promise<void> {
  if (!canSelfUpdate()) {
    throw new Error("当前为安装版，无法自动替换程序；请下载免安装版或重新运行安装包更新");
  }
  const target = updateTarget();
  log.info(`[updater] 开始更新：目标 ${target}（运行中：${app.getPath("exe")}）`);
  let staged = "";
  try {
    staged = await downloadToStaging(url);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : `更新失败：${String(err)}`);
  }
  log.info(`[updater] 下载完成，准备替换`);
  const script = await writeSwapScript(staged, target);
  const launch = updateLaunch(script);
  spawn(launch.command, launch.args, launch.options).unref();
  log.info(`[updater] 已启动替换脚本，退出当前进程`);
  setTimeout(() => app.quit(), 300);
}
