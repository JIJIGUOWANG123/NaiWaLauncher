import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstalledJava } from "../../shared/types";
import { getSettings } from "../core/settings";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getVersionJson } from "../minecraft/manifest";
import { readJavaMeta } from "./liberica";
import { installJavaFrom } from "./sources";
import { detectVendor } from "./vendor";
import { mt } from "../core/i18n";

const log = logger("java/locate");
function vendorUnknown(): string {
  return mt("java.locate.vendorUnknown");
}

/** 扫描结果缓存：java -version 每次要几十到几百毫秒。 */
let cache: InstalledJava[] | null = null;

function normalize(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** "1.8.0_412" → 8，"21.0.13" → 21。 */
export function parseMajorFromVersionOutput(text: string): number | undefined {
  const quoted = /version "([0-9][^"]*)"/i.exec(text);
  const raw = quoted?.[1] ?? /(\d+\.\d+[.\w+-]*)/.exec(text)?.[1];
  if (!raw) return undefined;
  const parts = raw.split(/[._\-+]/).filter((p) => p.length > 0);
  const first = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isFinite(first)) return undefined;
  if (first === 1) {
    const second = Number.parseInt(parts[1] ?? "", 10);
    return Number.isFinite(second) ? second : undefined;
  }
  return first;
}

/** 跑一次 java -version 取主版本；失败返回 undefined（路径可能不是可用 JDK）。 */
export function probeMajor(javaExe: string, timeoutMs = 8000): Promise<number | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: number | undefined): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(javaExe, ["-version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); finish(undefined); });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? parseMajorFromVersionOutput(out) : undefined);
    });
  });
}

async function scanHome(home: string, vendorFallback: string): Promise<InstalledJava | undefined> {
  const javawExe = join(home, "bin", "javaw.exe");
  if (!existsSync(javawExe)) return undefined;
  const meta = await readJavaMeta(home);
  // 来源识别：来源记录 → 目录名前缀 → JDK release 文件 → system
  const source = await detectVendor(home, meta?.vendor);
  if (meta) {
    return { major: meta.major, version: meta.version, path: meta.javawExe, vendor: meta.vendor || vendorFallback, source };
  }
  const major = await probeMajor(join(home, "bin", "java.exe"));
  if (major === undefined) return undefined;
  return { major, version: String(major), path: javawExe, vendor: vendorFallback, source };
}

/** 常见安装位置：只列固定父目录下的一级子目录，避免全盘扫描。 */
function systemRoots(): string[] {
  const env = process.env;
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;
  const parents = [
    join(programFiles, "Java"),
    join(programFilesX86, "Java"),
    join(programFiles, "Eclipse Adoptium"),
    join(programFiles, "Eclipse Foundation"),
    join(programFiles, "BellSoft"),
    join(programFiles, "Microsoft"),
    join(programFiles, "Amazon Corretto"),
    join(programFiles, "Zulu"),
    join(programFiles, "Semeru"),
    join(programFiles, "RedHat"),
    join(programFiles, "IBM"),
  ];
  if (localAppData) parents.push(join(localAppData, "Programs", "Eclipse Adoptium"));
  if (appData) parents.push(join(appData, ".jdks"));
  return parents;
}

async function expandCandidates(): Promise<string[]> {
  const homes = new Set<string>();
  const paths = getPaths();

  // 启动器自管目录优先生效
  try {
    for (const e of await readdir(paths.java, { withFileTypes: true })) {
      if (e.isDirectory()) homes.add(join(paths.java, e.name));
    }
  } catch {
    // java/ 还没建，忽略
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = join(dir, e.name);
      if (existsSync(join(sub, "bin", "javaw.exe"))) homes.add(sub);
      else await walk(sub, depth + 1);
    }
  };
  for (const parent of systemRoots()) await walk(parent, 0);

  // PATH 上的 java.exe
  for (const raw of (process.env.PATH ?? "").split(";")) {
    const dir = raw.trim();
    if (!dir) continue;
    if (existsSync(join(dir, "java.exe"))) homes.add(dir.replace(/[\\/]bin\\?$/i, "").replace(/[\\/]bin$/i, ""));
  }
  return [...homes];
}

export async function listInstalledJava(forceRefresh = false): Promise<InstalledJava[]> {
  if (cache && !forceRefresh) return cache;
  const homes = await expandCandidates();
  const seen = new Set<string>();
  const found: InstalledJava[] = [];
  for (const home of homes) {
    const info = await scanHome(home, vendorUnknown());
    if (!info) continue;
    const key = normalize(info.path);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(info);
  }
  found.sort((a, b) => (a.major - b.major) || a.version.localeCompare(b.version));
  cache = found;
  return found;
}

/** 清缓存：装完新 JDK 后调用。 */
export function invalidateJavaCache(): void {
  cache = null;
}

function compareMc(a: string, b: string): number {
  const pa = a.split(/[.\-+_]/).filter(Boolean).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+_]/).filter(Boolean).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 兜底启发式（只在拿不到版本 JSON 时使用）：
 *   ≤1.16.5 → 8；1.17–1.20.4 → 17；1.x 其余 → 21；**26.x 起的新版本号体系 → 25**；
 *   解析不出的自定义/未来 id 一律按 25 起步（宁可多装一个 JDK，也不要拿 21 去跑 class 69 崩溃）。
 * 26.x 是第一代需要 Java 25 的正式版本（版本 JSON 里 javaVersion.majorVersion = 25）。
 */
export function requiredJavaMajor(mcVersion: string): number {
  const head = mcVersion.trim().split(/[.\-+_]/)[0];
  if (!/^\d+$/.test(head)) return 25;
  const year = Number(head);
  if (year >= 26) return 25;
  if (compareMc(mcVersion, "1.16.5") <= 0) return 8;
  if (compareMc(mcVersion, "1.20.4") <= 0) return 17;
  if (year === 1) return 21;
  return 25;
}

/**
 * 权威来源：版本 JSON 的 javaVersion.majorVersion。getVersionJson 已消解 inheritsFrom，
 * 未安装时会回落到官方元数据；只有拿不到时才退回启发式。
 * 26.3 必须靠它（majorVersion=25），否则会拿 21 去跑 class 69 直接崩。
 */
export async function resolveRequiredMajor(mcVersion: string): Promise<number> {
  try {
    const json = await getVersionJson(mcVersion);
    const major = Number(json?.javaVersion?.majorVersion);
    if (Number.isInteger(major) && major >= 8) {
      // 新版本号体系（26.x 起）最低也要 25：JSON 若声明更低，按 25 兜底，避免 class 版本不足
      const year = Number(mcVersion.trim().split(/[.\-+_]/)[0]);
      return year >= 26 ? Math.max(major, 25) : major;
    }
    log.info(`${mcVersion} 的版本 JSON 未声明 javaVersion，改用启发式`);
  } catch (err) {
    log.warn(`读取 ${mcVersion} 的 javaVersion 失败，改用启发式：${(err as Error).message}`);
  }
  return requiredJavaMajor(mcVersion);
}

function isManaged(info: InstalledJava): boolean {
  return normalize(info.path).startsWith(normalize(getPaths().java) + "/");
}

/**
 * 选主版本最低且满足要求的 JDK；同主版本优先启动器自管。
 * Java 8 时代（≤1.16.5）必须精确 8：高版本 JVM 跑不起来，宁可去自动下载。
 */
export async function findJavaHome(major: number): Promise<string | undefined> {
  const all = await listInstalledJava();
  const usable = all.filter((j) => (major <= 8 ? j.major === major : j.major >= major));
  if (usable.length === 0) return undefined;
  usable.sort((a, b) => {
    if (a.major !== b.major) return a.major - b.major;
    const am = isManaged(a) ? 0 : 1;
    const bm = isManaged(b) ? 0 : 1;
    if (am !== bm) return am - bm;
    return b.version.localeCompare(a.version);
  });
  return dirname(dirname(usable[0].path));
}

/** 返回 javaw.exe 路径；本地没有满足版本且允许自动下载时装一份该主版本。 */
export async function resolveJavaFor(mcVersion: string): Promise<string> {
  const major = await resolveRequiredMajor(mcVersion);
  const home = await findJavaHome(major);
  if (home) {
    const javawExe = join(home, "bin", "javaw.exe");
    if (existsSync(javawExe)) {
      log.info(`${mcVersion} 需要 Java ${major}，选用 ${javawExe}`);
      return javawExe;
    }
  }
  if (!getSettings().javaAutoDownload) {
    throw new Error(mt("java.requiredMissing", { major }));
  }
  log.info(`${mcVersion} 需要 Java ${major}，本机没有满足的版本，按设置的下载源自动安装`);
  const installed = await installJavaFrom(major);
  invalidateJavaCache();
  if (installed.major < major) {
    throw new Error(mt("java.autoTooLow", { got: installed.major, need: major }));
  }
  log.info(`已安装 Java ${installed.major}（${installed.version}）：${installed.path}`);
  return installed.path;
}

/** 安装器需要控制台版 java.exe（要读日志）。 */
export async function resolveJavaExeForMc(mcVersion: string): Promise<string> {
  const javawExe = await resolveJavaFor(mcVersion);
  return join(dirname(javawExe), "java.exe");
}
