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

/** 判断当前运行的是否为免安装单文件版（安装版在 Program Files，需要管理员权限，不做自替换）。 */
export function canSelfUpdate(): boolean {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return true;
  const exe = app.getPath("exe");
  const lowered = exe.toLowerCase();
  if (lowered.includes("program files") || lowered.includes("appdata\\local\\programs")) return false;
  return true;
}

/** 下载新版本到 NaiWa/update，返回文件路径。 */
async function downloadToStaging(url: string): Promise<string> {
  const dir = join(getPaths().dataRoot, "update");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, SINGLE_EXE_NAME);
  await rm(dest, { force: true });
  await downloadFile(url, dest, { label: "更新启动器", connections: 4 });
  const size = (await readFile(dest)).byteLength;
  if (size < 20 * 1024 * 1024) throw new Error(`更新包大小异常（${size} 字节），已取消`);
  return dest;
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
  const target = app.getPath("exe");
  log.info(`[updater] 开始更新：${target}`);
  const staged = await downloadToStaging(url);
  log.info(`[updater] 下载完成，准备替换`);
  const script = await writeSwapScript(staged, target);
  spawn("cmd.exe", ["/c", "start", "/min", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  log.info(`[updater] 已启动替换脚本，退出当前进程`);
  setTimeout(() => app.quit(), 300);
}
