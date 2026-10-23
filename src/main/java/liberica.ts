import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { InstalledJava, JavaRelease } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { downloadFile, fetchJson } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { installDirName, writeSourceRecord } from "./vendor";

const log = logger("java/liberica");

const API = "https://api.bell-sw.com/v1/liberica/releases";
const VENDOR = "BellSoft Liberica";
/** Java 页展示的主版本；MC 26.x 起需要 25，所以必须覆盖到 25。 */
const LISTED_MAJORS = [8, 17, 21, 25];

/** BellSoft API 原始条目，只取用得到的字段。 */
interface BellSwRelease {
  version: string;
  filename: string;
  downloadUrl: string;
  size?: number;
  sha1?: string;
  LTS?: boolean;
  featureVersion: number;
  interimVersion?: number;
  updateVersion?: number;
  patchVersion?: number;
  extraVersion?: number;
  buildVersion?: number;
  latestInFeatureVersion?: boolean;
  bundleType?: string;
  packageType?: string;
  os?: string;
  architecture?: string;
}

/** .naiwa.json：记录 JDK 归属信息，避免每次都重新嗅探 major。 */
interface JavaMetaFile {
  major: number;
  version: string;
  vendor: string;
  javaExe: string;
  javawExe: string;
  installedAt: number;
  source: string;
}

/** 目录名不能带 Windows 保留字符；版本号里的 + 等字符要保住可读性。 */
function safeSegment(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, "_");
}

/** 版本串（8u472+11 / 17+35 / 21.0.13+11）本身不适合直接比较，优先用 API 的数值字段。 */
function releaseRank(r: BellSwRelease): number[] {
  const tuple = [
    r.featureVersion ?? 0,
    r.interimVersion ?? 0,
    r.updateVersion ?? 0,
    r.patchVersion ?? 0,
    r.extraVersion ?? 0,
    r.buildVersion ?? 0,
  ];
  if (tuple.every((n) => n === 0)) {
    const parsed = r.version.split(/[._u+-]/).map((x) => Number.parseInt(x, 10) || 0);
    return [parsed[0] ?? 0, 0, parsed[1] ?? 0, 0, 0, parsed[2] ?? 0];
  }
  return tuple;
}

function compareRankDesc(a: BellSwRelease, b: BellSwRelease): number {
  const ra = releaseRank(a);
  const rb = releaseRank(b);
  for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
    const d = (rb[i] ?? 0) - (ra[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchReleases(major: number, signal?: AbortSignal): Promise<BellSwRelease[]> {
  // arch=x86 是 BellSoft API 对 64 位的写法（返回 amd64），bitness 才是位宽。
  const url = `${API}?version-feature=${major}&os=windows&arch=x86&bitness=64&bundle-type=jdk&output=json`;
  const raw = await fetchJson<BellSwRelease[]>(url, { allowMirror: false, signal });
  // 同一批结果里混着 msi/rpm/deb，这里只认 zip，且要求 downloadUrl 也是 zip
  return raw
    .filter((r) => typeof r.filename === "string"
      && r.filename.toLowerCase().endsWith(".zip")
      && String(r.downloadUrl ?? "").toLowerCase().endsWith(".zip"))
    .sort(compareRankDesc);
}

export async function listReleases(majors: number[] = LISTED_MAJORS): Promise<JavaRelease[]> {
  const out: JavaRelease[] = [];
  const settled = await Promise.all(majors.map(async (major) => {
    try {
      return { major, releases: await fetchReleases(major) };
    } catch (err) {
      log.warn(`获取 Liberica JDK ${major} 列表失败：${(err as Error).message}`);
      return { major, releases: [] as BellSwRelease[] };
    }
  }));
  for (const { major, releases } of settled.sort((a, b) => a.major - b.major)) {
    for (const r of releases) {
      out.push({
        version: r.version,
        major,
        lts: r.LTS === true,
        downloadUrl: r.downloadUrl,
        fileName: r.filename,
        sizeBytes: r.size,
      });
    }
  }
  return out;
}

/** 把解压出来的 JDK 顶层目录找出来（zip 内一般包一层 jdk-xx 目录）。 */
async function findJdkRoot(dir: string): Promise<string | undefined> {
  if (existsSync(join(dir, "bin", "javaw.exe"))) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = join(dir, e.name);
    if (existsSync(join(sub, "bin", "javaw.exe"))) return sub;
  }
  return undefined;
}

/**
 * 下载通道：API 给的 downloadUrl 指向 github.com/releases，在国内经常不可达且只有 ~250KB/s；
 * BellSoft 自家 CDN 是同一份文件（实测 1.1MB/s），优先用它，失败再退回 GitHub。
 */
function downloadChannels(release: BellSwRelease): string[] {
  const urls: string[] = [];
  if (release.downloadUrl.includes("github.com/bell-sw/Liberica/releases/download/")) {
    urls.push(`https://download.bell-sw.com/java/${release.version}/${release.filename}`);
  }
  urls.push(release.downloadUrl);
  return [...new Set(urls)];
}

async function downloadZip(
  release: BellSwRelease,
  zipPath: string,
  task: TaskHandle,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (const url of downloadChannels(release)) {
    try {
      const got = await downloadFile(url, zipPath, { task, expectedSha1: release.sha1, label: release.filename, signal });
      log.info(`JDK 压缩包来自 ${new URL(url).host}：${got.bytes} 字节 (reused=${got.reused})`);
      return;
    } catch (err) {
      // 取消不换通道：用户已经不想要这个 JDK 了
      if (signal?.aborted) throw err;
      lastError = err;
      log.warn(`JDK 下载通道不可用，换下一个：${url} · ${(err as Error).message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function readJavaMeta(home: string): Promise<JavaMetaFile | undefined> {
  const file = join(home, ".naiwa.json");
  if (!existsSync(file)) return undefined;
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as JavaMetaFile;
  } catch {
    return undefined;
  }
}

/** 已装过就直接复用（幂等），否则下载 zip → 解压 → 校验 javaw.exe → 写元信息。 */
async function installRelease(major: number, release: BellSwRelease, signal?: AbortSignal): Promise<InstalledJava> {
  const paths = getPaths();
  // 目录名统一成 <source>-<major>-<version>，扫描时仅看名字也能认出是谁装的
  const segment = installDirName("bellsoft", major, release.version);
  const home = join(paths.java, segment);
  const javawExe = join(home, "bin", "javaw.exe");
  const javaExe = join(home, "bin", "java.exe");

  if (existsSync(javawExe)) {
    const meta = await readJavaMeta(home);
    // 补齐来源记录（老目录可能没有），让「来源识别」有据可依
    await writeSourceRecord(home, {
      source: "bellsoft",
      version: meta?.version ?? release.version,
      installedAt: Date.now(),
      downloadUrl: release.downloadUrl,
    }).catch(() => undefined);
    log.info(`JDK ${major} 已存在，复用 ${home}`);
    return { major, version: meta?.version ?? release.version, path: javawExe, vendor: VENDOR, source: "bellsoft" };
  }

  await mkdir(paths.java, { recursive: true });
  const zipPath = join(paths.downloads, safeSegment(release.filename));
  const task = createTask("java", `安装 JDK ${major} (${release.version})`);
  try {
    task.update({ stage: "下载 JDK", percent: 0 });
    await downloadZip(release, zipPath, task, signal);

    task.update({ stage: "解压 JDK" });
    const tmp = join(paths.downloads, "unpack", `${segment}-${Date.now()}`);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    new AdmZip(zipPath).extractAllTo(tmp, true);
    const root = await findJdkRoot(tmp);
    if (!root) throw new Error(`JDK 压缩包结构异常，未找到 bin/javaw.exe：${release.filename}`);

    await rm(home, { recursive: true, force: true });
    await mkdir(join(home, ".."), { recursive: true });
    await rename(root, home);
    await rm(tmp, { recursive: true, force: true });

    if (!existsSync(javawExe)) throw new Error(`解压后缺少 javaw.exe：${home}`);
    const st = await stat(javawExe);
    if (st.size === 0) throw new Error(`javaw.exe 为空文件：${home}`);

    const meta: JavaMetaFile = {
      major,
      version: release.version,
      vendor: VENDOR,
      javaExe,
      javawExe,
      installedAt: Date.now(),
      source: release.downloadUrl,
    };
    await writeFile(join(home, ".naiwa.json"), JSON.stringify(meta, null, 2), "utf8");
    await writeSourceRecord(home, {
      source: "bellsoft",
      version: release.version,
      installedAt: meta.installedAt,
      downloadUrl: release.downloadUrl,
    });
    log.info(`JDK ${major} 安装完成：${home}`);
    task.done({ major, version: release.version, path: javawExe });
    return { major, version: release.version, path: javawExe, vendor: VENDOR, source: "bellsoft" };
  } catch (err) {
    task.fail(err);
    throw err;
  } finally {
    // 保留 zip 作为下载缓存（断点续传/重装复用），只清理解压残留。
    await rm(join(paths.downloads, "unpack"), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** version 精确匹配优先，其次前缀匹配，最后退到该主版本最新版。 */
export async function install(major: number, version?: string, signal?: AbortSignal): Promise<InstalledJava> {
  const releases = await fetchReleases(major, signal);
  if (releases.length === 0) throw new Error(`BellSoft 没有 JDK ${major} 的 Windows 64 位 zip 包（列表里可能只有 msi）`);
  const want = (version ?? "").trim();
  let hit: BellSwRelease | undefined;
  if (want) {
    hit = releases.find((r) => r.version === want)
      ?? releases.find((r) => r.version.startsWith(`${want}+`) || r.version === `${want}.0`)
      ?? releases.find((r) => r.version.startsWith(want));
    if (!hit) throw new Error(`JDK ${major} 没有版本 ${want}，可用：${releases.slice(0, 5).map((r) => r.version).join(", ")}`);
  } else {
    hit = releases.find((r) => r.latestInFeatureVersion) ?? releases[0];
  }
  return installRelease(major, hit, signal);
}

/** 供 locate 自动安装时复用：按主版本取最新 GA 版本。 */
export async function latestReleaseOf(major: number): Promise<JavaRelease> {
  const releases = await fetchReleases(major);
  const hit = releases.find((r) => r.latestInFeatureVersion) ?? releases[0];
  if (!hit) throw new Error(`BellSoft 没有 JDK ${major} 的 Windows 64 位 zip 包（列表里可能只有 msi）`);
  return {
    version: hit.version,
    major,
    lts: hit.LTS === true,
    downloadUrl: hit.downloadUrl,
    fileName: hit.filename,
    ...(hit.size !== undefined ? { sizeBytes: hit.size } : {}),
    ...(hit.sha1 ? { sha1: hit.sha1 } : {}),
    source: "bellsoft",
  };
}
