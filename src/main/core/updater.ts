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


/** 生成替换脚本：等主进程退出后覆盖 exe，再启动新版。 */
async function writeSwapScript(staged: string, target: string): Promise<string> {
  const script = join(tmpdir(), `naiwa-update-${Date.now()}.cmd`);
  const body = [
    "@echo off",
    "timeout /t 2 /nobreak >nul",
    ":retry",
    `move /y "${staged}" "${target}" >nul 2>&1`,
    "if errorlevel 1 (",
    "  timeout /t 1 /nobreak >nul",
    "  goto retry",
    ")",
    `start "" "${target}"`,
    `del "${script.replace(/\\/g, "\\\\")}" >nul 2>&1`,
  ].join("\r\n");
  await writeFile(script, body, "utf8");
  return script;
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
  spawn("cmd.exe", ["/c", "start", "/min", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  log.info(`[updater] 已启动替换脚本，退出当前进程`);
  setTimeout(() => app.quit(), 300);
}
