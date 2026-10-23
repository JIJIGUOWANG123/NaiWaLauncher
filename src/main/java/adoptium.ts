// Adoptium Temurin 官方 API + 清华 TUNA 镜像：同一份清单，两个下载源。
//
// 官方接口（实测）：
//   GET https://api.adoptium.net/v3/assets/latest/{feature}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse
//   → 数组，取 [0]：
//       version.semver        21.0.12+101.0.LTS
//       release_name          jdk-21.0.12.1+1
//       binary.package.name   OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip
//       binary.package.size   202557426
//       binary.package.link   https://github.com/adoptium/temurin21-binaries/releases/download/...
//       binary.package.checksum  （sha256）
//
// TUNA 镜像目录（fancyindex）：
//   https://mirrors.tuna.tsinghua.edu.cn/Adoptium/{feature}/jdk/x64/windows/
//   里的文件名与上面的 package.name 完全一致，所以只换下载地址，清单仍然只有一份。
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { InstalledJava, JavaRelease } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { downloadFile, fetchJson, fetchText } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { installDirName, writeSourceRecord, type ManagedSource } from "./vendor";

const log = logger("java/adoptium");

const API = "https://api.adoptium.net/v3/assets/latest";
const TUNA_BASE = "https://mirrors.tuna.tsinghua.edu.cn/Adoptium";
/** 清单缓存 10 分钟：Java 页会反复拉同一批主版本。 */
const CACHE_TTL_MS = 10 * 60_000;
/** 与 Liberica 保持一致的主版本列表（MC 26.x 起需要 25）。 */
export const ADOPTIUM_MAJORS = [8, 17, 21, 25];
const VENDOR = "Eclipse Temurin";

export type AdoptiumSource = Extract<ManagedSource, "adoptium" | "tuna">;

/** TUNA 镜像里同一个文件的地址（文件名与 Adoptium package.name 一致）。 */
export function tunaUrl(major: number, fileName: string): string {
  return TUNA_BASE + "/" + major + "/jdk/x64/windows/" + fileName.replace(/ /g, "%20");
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 纯函数：Adoptium 资产条目 → 统一的 JavaRelease（自检直接用夹具断言）。
 * 缺 package.name 就当作无效条目（没有文件名就没法下载/命名）。
 */
export function adoptiumReleaseOf(raw: unknown, major: number, source: AdoptiumSource): JavaRelease | undefined {
  const item = asObject(raw);
  const version = asObject(item.version);
  const pkg = asObject(asObject(item.binary).package);
  const fileName = asString(pkg.name);
  if (!fileName) return undefined;
  const semver = asString(version.semver);
  const size = asNumber(pkg.size);
  const checksum = asString(pkg.checksum);
  const link = asString(pkg.link);
  return {
    version: semver || asString(item.release_name) || fileName,
    major,
    lts: /LTS/i.test(semver),
    downloadUrl: source === "tuna" ? tunaUrl(major, fileName) : link,
    fileName,
    ...(size > 0 ? { sizeBytes: size } : {}),
    ...(checksum ? { sha256: checksum } : {}),
    source,
  };
}

interface CacheEntry {
  at: number;
  /** 缓存始终存「官方源」那条，换源时只改 downloadUrl，避免两个源各存一份。 */
  release: JavaRelease;
}

const cache = new Map<number, CacheEntry>();

async function fetchLatest(major: number, signal?: AbortSignal): Promise<JavaRelease> {
  const hit = cache.get(major);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.release;
  const url =
    API + "/" + major + "/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse";
  let body: unknown;
  try {
    body = await fetchJson<unknown>(url, { allowMirror: false, timeoutMs: 15000, signal });
  } catch (err) {
    throw new Error("获取 Adoptium JDK " + major + " 列表失败：" + (err instanceof Error ? err.message : String(err)));
  }
  const first = Array.isArray(body) ? body[0] : undefined;
  const release = adoptiumReleaseOf(first, major, "adoptium");
  if (!release) throw new Error("Adoptium 没有 JDK " + major + " 的 Windows x64 JDK 包（接口返回为空）");
  cache.set(major, { at: Date.now(), release });
  return release;
}

/** 某个主版本的最新版（source = adoptium / tuna 只影响下载地址与 source 字段）。 */
export async function latestRelease(major: number, source: AdoptiumSource, signal?: AbortSignal): Promise<JavaRelease> {
  const base = await fetchLatest(major, signal);
  if (source === "tuna") return { ...base, source: "tuna", downloadUrl: tunaUrl(major, base.fileName) };
  return { ...base, source: "adoptium" };
}

export async function listReleases(majors: number[] = ADOPTIUM_MAJORS, source: AdoptiumSource = "adoptium"): Promise<JavaRelease[]> {
  const settled = await Promise.all(
    majors.map(async (major) => {
      try {
        return await latestRelease(major, source);
      } catch (err) {
        log.warn("获取 Adoptium JDK " + major + " 失败：" + (err instanceof Error ? err.message : String(err)));
        return undefined;
      }
    }),
  );
  return settled.filter((item): item is JavaRelease => item !== undefined).sort((a, b) => a.major - b.major);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * 下载并校验：优先 sha256（Adoptium 给的是 sha256），没有哈希就按大小。
 * downloadFile 只支持 expectedSha1，所以哈希在这里自己算；不匹配先删再重下一次。
 */
async function downloadVerified(
  release: JavaRelease,
  zipPath: string,
  task: TaskHandle,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await downloadFile(release.downloadUrl, zipPath, { task, label: release.fileName, signal });
    const size = (await stat(zipPath)).size;
    const expectedSize = release.sizeBytes && release.sizeBytes > 0 ? release.sizeBytes : 0;
    if (release.sha256) {
      const actual = (await sha256Of(zipPath)).toLowerCase();
      if (actual === release.sha256.toLowerCase()) return;
      await rm(zipPath, { force: true });
      if (attempt >= 2) {
        throw new Error("JDK 压缩包 sha256 校验失败：期望 " + release.sha256 + "，实际 " + actual);
      }
      log.warn("JDK 压缩包 sha256 不一致，重下一次：" + release.fileName);
      continue;
    }
    if (expectedSize > 0 && size !== expectedSize) {
      await rm(zipPath, { force: true });
      if (attempt >= 2) {
        throw new Error("JDK 压缩包大小校验失败：期望 " + expectedSize + " 字节，实际 " + size + " 字节");
      }
      log.warn("JDK 压缩包大小不一致，重下一次：" + release.fileName);
      continue;
    }
    return;
  }
}

/** TUNA 目录页里确实有这个名字才下载：镜像可能比官方慢半拍，先给可读错误。 */
async function assertTunaHas(major: number, fileName: string): Promise<void> {
  const dirUrl = TUNA_BASE + "/" + major + "/jdk/x64/windows/";
  try {
    const html = await fetchText(dirUrl, { allowMirror: false, timeoutMs: 15000, retries: 1 });
    if (!html.includes(fileName)) {
      throw new Error("TUNA 镜像里还没有 " + fileName + "，请改用 Adoptium 官方源重试");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("TUNA 镜像里还没有")) throw err;
    // 目录页拿不到（限流/网络抖动）不阻断：直接尝试下载，失败时下载层会报出真实原因
    log.warn("TUNA 目录校验失败，直接尝试下载：" + message);
  }
}

async function findJdkRoot(dir: string): Promise<string | undefined> {
  if (existsSync(join(dir, "bin", "javaw.exe"))) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    if (existsSync(join(sub, "bin", "javaw.exe"))) return sub;
  }
  return undefined;
}

interface JavaMetaFile {
  major: number;
  version: string;
  vendor: string;
  javaExe: string;
  javawExe: string;
  installedAt: number;
  source: string;
}

async function writeMeta(
  home: string,
  major: number,
  release: JavaRelease,
  javaExe: string,
  javawExe: string,
): Promise<void> {
  const installedAt = Date.now();
  const meta: JavaMetaFile = {
    major,
    version: release.version,
    vendor: VENDOR,
    javaExe,
    javawExe,
    installedAt,
    source: release.downloadUrl,
  };
  await writeFile(join(home, ".naiwa.json"), JSON.stringify(meta, null, 2), "utf8");
  await writeSourceRecord(home, {
    source: release.source === "tuna" ? "tuna" : "adoptium",
    version: release.version,
    installedAt,
    downloadUrl: release.downloadUrl,
  });
}

/** 装一个 Adoptium/TUNA 的 JDK：目录名带来源（<source>-<major>-<version>），并写来源记录。 */
export async function install(
  major: number,
  version: string | undefined,
  source: AdoptiumSource,
  signal?: AbortSignal,
): Promise<InstalledJava> {
  const release = await latestRelease(major, source, signal);
  const want = (version ?? "").trim();
  // 接口只给「最新版」：指定版本与最新版不同时按最新版装（界面列表也来自同一个接口，正常不会触发）
  if (want && want !== release.version) {
    log.warn("指定版本 " + want + " 不是 Adoptium 当前最新版（" + release.version + "），按最新版安装");
  }

  const paths = getPaths();
  const dir = join(paths.java, installDirName(release.source === "tuna" ? "tuna" : "adoptium", major, release.version));
  const javawExe = join(dir, "bin", "javaw.exe");
  const javaExe = join(dir, "bin", "java.exe");
  const vendorSource = release.source === "tuna" ? "tuna" : "adoptium";

  if (existsSync(javawExe)) {
    // 已装过：补写来源记录（旧版本可能没有），直接复用
    await writeSourceRecord(dir, {
      source: vendorSource,
      version: release.version,
      installedAt: Date.now(),
      downloadUrl: release.downloadUrl,
    }).catch(() => undefined);
    log.info("JDK " + major + " 已存在，复用 " + dir);
    return { major, version: release.version, path: javawExe, vendor: VENDOR, source: vendorSource };
  }

  await mkdir(paths.java, { recursive: true });
  const zipPath = join(paths.downloads, installDirName(vendorSource, major, release.version) + ".zip");
  const task = createTask("java", "安装 JDK " + major + " (" + release.version + ")");
  try {
    task.update({ stage: "下载 JDK", percent: 0 });
    if (vendorSource === "tuna") await assertTunaHas(major, release.fileName);
    await downloadVerified(release, zipPath, task, signal);

    task.update({ stage: "解压 JDK" });
    const tmp = join(paths.downloads, "unpack", "jdk-" + Date.now());
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    new AdmZip(zipPath).extractAllTo(tmp, true);
    const root = await findJdkRoot(tmp);
    if (!root) throw new Error("JDK 压缩包结构异常，未找到 bin/javaw.exe：" + release.fileName);

    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, ".."), { recursive: true });
    await rename(root, dir);
    await rm(tmp, { recursive: true, force: true });

    if (!existsSync(javawExe)) throw new Error("解压后缺少 javaw.exe：" + dir);
    await writeMeta(dir, major, release, javaExe, javawExe);
    log.info("JDK " + major + " 安装完成（" + vendorSource + "）：" + dir);
    task.done({ major, version: release.version, path: javawExe });
    return { major, version: release.version, path: javawExe, vendor: VENDOR, source: vendorSource };
  } catch (err) {
    task.fail(err);
    throw err;
  } finally {
    await rm(join(paths.downloads, "unpack"), { recursive: true, force: true }).catch(() => undefined);
  }
}
