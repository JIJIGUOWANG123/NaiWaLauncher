import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkAppUpdates, compareVersion } from "./updates";
import type { UpdateCheckResult } from "../../shared/types";
import { downloadFile } from "./http";
import { getPaths } from "./paths";
import { logger } from "./logger";
import { mt } from "./i18n";
import { githubUrlCandidates } from "../net/github";

const log = logger("updater");

/**
 * 自动更新时主进程要观察的进度点：全部是可选的，界面据此给「不阻塞」的提示。
 * beforeInstall 是安装前的门禁 —— 安装要重启启动器，有游戏在跑时必须在这里等。
 */
export interface InstallProgress {
  onDownloading?(latest: string): void;
  onDownloaded?(latest: string): void;
  onInstalling?(latest: string): void;
  beforeInstall?(): Promise<void>;
}

/** 「上次自动更新成功」的标记文件：装好重启后据此提示「已更新到 vX」。 */
function appliedMarkerPath(): string {
  return join(getPaths().dataRoot, "update", "applied.json");
}

/** 记下这次自动更新要装到的版本；写不进去只影响下次启动的提示，不拦更新。 */
async function writeAppliedMarker(latest: string): Promise<void> {
  if (!latest) return;
  const file = appliedMarkerPath();
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ latest, at: Date.now() }), "utf8");
  } catch (err) {
    log.warn("[updater] 写更新标记失败（不影响更新）：" + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * 读出「上次自动更新」的目标版本并删掉标记。
 * 只有当前版本真的等于该版本时才返回它 —— 否则（安装失败、换回了旧包）宁可什么也不提示。
 */
export async function consumeAppliedMarker(): Promise<string | null> {
  const file = appliedMarkerPath();
  try {
    const raw = await readFile(file, "utf8");
    await rm(file, { force: true });
    const parsed = JSON.parse(raw) as { latest?: unknown };
    const latest = typeof parsed.latest === "string" ? parsed.latest : "";
    if (!latest) return null;
    const current = app.getVersion();
    if (compareVersion(current, latest) !== 0) {
      log.warn("[updater] 更新标记是 " + latest + "，但当前版本是 " + current + "：不提示已更新");
      return null;
    }
    return latest;
  } catch {
    // 没有标记 / 内容坏了：当作没有发生过更新
    return null;
  }
}

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

/**
 * 更新方式：
 * - portable：单文件免安装版，替换 PORTABLE_EXECUTABLE_FILE 指向的那个 exe；
 * - setup：安装版（Program Files 或自定义目录如 D:\minecraft\NW），下载 Release 里的
 *   NaiWaLauncher-Setup.exe 静默安装回**当前所在目录**，再启动新版；
 * - none：临时解压副本等无法自我更新的场景。
 */
export type UpdateMode = "portable" | "setup" | "none";

export function updateMode(): UpdateMode {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && portable.toLowerCase().endsWith(".exe")) return "portable";
  const target = updateTarget().toLowerCase();
  if (target.startsWith(tmpdir().toLowerCase())) return "none";
  return "setup";
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

/**
 * 生成候选下载地址：七个 GitHub 加速节点在前（按设置顺序：auto 先测速排序，固定节点优先），
 * 原始地址最后兜底。非 GitHub 地址只有它自己。
 */
async function downloadCandidates(url: string): Promise<string[]> {
  return githubUrlCandidates(url);
}

/** 下载新版本到 NaiWa/update，返回文件路径；直连失败会自动换镜像。 */
async function downloadToStaging(url: string): Promise<string> {
  const dir = join(getPaths().dataRoot, "update");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, SINGLE_EXE_NAME);
  let lastError = "";
  for (const candidate of await downloadCandidates(url)) {
    await rm(dest, { force: true });
    try {
      log.info(`[updater] 下载更新包：${candidate}`);
      await downloadFile(candidate, dest, { label: mt("upd.downloadLabel"), connections: 4 });
      const size = (await readFile(dest)).byteLength;
      if (size < 20 * 1024 * 1024) throw new Error(mt("upd.badSize", { size }));
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`[updater] 该地址下载失败（${candidate}）：${lastError}`);
    }
  }
  throw new Error(mt("upd.packageDownloadFailed", { error: lastError || mt("upd.networkUnavailable") }));
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

/** 安装版更新：生成「等程序退出 → 静默跑安装包装回原目录 → 启动新版」的脚本。 */
export function setupScriptBody(installer: string, root: string, appExe: string, scriptPath: string): string {
  // /S 静默安装；/D= 必须是最后一个参数且不带引号，路径里有空格也没问题（NSIS 取剩余整行）
  return [
    "@echo off",
    "ping -n 3 127.0.0.1 >nul",
    '"' + installer + '" /S /D=' + root,
    "ping -n 3 127.0.0.1 >nul",
    'start "" "' + appExe + '"',
    'del "' + scriptPath + '" >nul 2>&1',
  ].join("\r\n");
}

/** 把安装版更新包下到 <dataRoot>/update，返回路径。 */
async function downloadSetup(url: string): Promise<string> {
  const dir = join(getPaths().dataRoot, "update");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, "NaiWaLauncher-Setup.exe");
  let lastError = "";
  for (const candidate of await downloadCandidates(url)) {
    await rm(dest, { force: true });
    try {
      log.info("[updater] 下载安装包：" + candidate);
      await downloadFile(candidate, dest, { label: mt("upd.downloadLabelSetup"), connections: 4 });
      const size = (await readFile(dest)).byteLength;
      if (size < 20 * 1024 * 1024) throw new Error(mt("upd.badSize", { size }));
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("[updater] 该地址下载失败（" + candidate + "）：" + lastError);
    }
  }
  throw new Error(mt("upd.downloadFailed", { error: lastError || mt("upd.networkUnavailable") }));
}

/** 安装版：下载 Setup 并静默装回当前目录，然后重启。 */
async function installViaSetup(url: string, latest: string, progress?: InstallProgress): Promise<void> {
  const root = getPaths().root;
  // 安装版把程序放在 <root>\main，数据留在 <root>；老版本平铺在根目录时回退到根目录的 exe
  const mainExe = join(root, "main", "NaiWa Launcher.exe");
  const currentExe = existsSync(mainExe) ? mainExe : join(root, "NaiWa Launcher.exe");
  if (!existsSync(currentExe)) {
    throw new Error(mt("upd.mainExeMissing", { path: mainExe }));
  }
  const installer = await downloadSetup(url);
  log.info("[updater] 下载完成：" + installer);
  progress?.onDownloaded?.(latest);
  // 安装会重启启动器：自动更新在这里等游戏结束（手动更新没有门禁，用户自己点的）
  await progress?.beforeInstall?.();
  const script = join(tmpdir(), "naiwa-setup-update-" + Date.now() + ".cmd");
  // 安装包一定把 exe 装到 <root>\main，重启目标就固定指向它（老版本的根目录 exe 交由安装包覆盖/丢弃）
  await writeFile(script, setupScriptBody(installer, root, mainExe, script), "utf8");
  log.info("[updater] 安装版更新：将静默安装到 " + root + "（程序在 main 子目录），脚本 " + script);
  const launch = updateLaunch(script);
  await writeAppliedMarker(latest);
  progress?.onInstalling?.(latest);
  spawn(launch.command, launch.args, launch.options).unref();
  log.info("[updater] 已启动安装脚本，退出当前进程");
  setTimeout(() => app.quit(), 300);
}

/**
 * 下载并应用更新：免安装版替换自身；安装版静默安装回原目录后重启。
 * checked 是调用方已经查到的结果（启动检查用过一次就别再查：一次启动只查一次）；
 * progress 让自动更新把进度推给界面、并在安装前等游戏结束。
 */
export async function installUpdate(url?: string, checked?: UpdateCheckResult, progress?: InstallProgress): Promise<void> {
  const mode = updateMode();
  if (mode === "none") {
    throw new Error(mt("upd.tempCopy"));
  }
  if (mode === "setup") {
    // 安装版要的是「安装包」，用 Release 里固定名的 Setup；调用方给的 url 可能是免安装版，忽略它
    const check = checked ?? (await checkAppUpdates());
    const setupUrl = check.setupUrl ?? url;
    if (!setupUrl) throw new Error(mt("upd.noSetup"));
    log.info("[updater] 安装版更新：当前 " + check.current + " → " + check.latest);
    progress?.onDownloading?.(check.latest ?? "");
    await installViaSetup(setupUrl, check.latest ?? "", progress);
    return;
  }
  const target = updateTarget();
  log.info("[updater] 开始更新：目标 " + target + "（运行中：" + app.getPath("exe") + "）");
  const check = checked ?? (await checkAppUpdates());
  const latest = check.latest ?? "";
  const source = url ?? check.assetUrl;
  if (!source) throw new Error(mt("upd.noPortable"));
  progress?.onDownloading?.(latest);
  let staged = "";
  try {
    staged = await downloadToStaging(source);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : mt("upd.failed", { error: String(err) }));
  }
  log.info("[updater] 下载完成，准备替换");
  progress?.onDownloaded?.(latest);
  // 安装会重启启动器：自动更新在这里等游戏结束（手动更新没有门禁，用户自己点的）
  await progress?.beforeInstall?.();
  const script = await writeSwapScript(staged, target);
  const launch = updateLaunch(script);
  await writeAppliedMarker(latest);
  progress?.onInstalling?.(latest);
  spawn(launch.command, launch.args, launch.options).unref();
  log.info("[updater] 已启动替换脚本，退出当前进程");
  setTimeout(() => app.quit(), 300);
}
