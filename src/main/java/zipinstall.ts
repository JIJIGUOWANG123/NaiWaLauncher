// 通用「下载 zip → 校验 → 解压 → 落盘到 <java>/<source>-<major>-<version>」安装流程。
// Adoptium 那条链路自带一份（adoptium.ts），新源（injdk / dragonwell）共用这里，
// 保证目录命名、.naiwa.json、naiwa-source.json 与老源完全一致，扫描时来源识别才不会漏。
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { InstalledJava, JavaRelease } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { downloadFile } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { installDirName, writeSourceRecord, type ManagedSource } from "./vendor";
import { mt } from "../core/i18n";

const log = logger("java/zip");

/** 下载校验失败时的重试次数（第二次仍不过就直接抛错，不再拖时间）。 */
const DOWNLOAD_ATTEMPTS = 2;

export interface ZipInstallOptions {
  /** 备用下载地址（首选不可达时按顺序换），例如 Dragonwell 的 GitHub 兜底。 */
  fallbackUrls?: string[];
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
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

/** 先按 sha256 校验，没有哈希就按大小；不匹配删掉重下一次。 */
async function downloadVerified(
  release: JavaRelease,
  zipPath: string,
  task: TaskHandle,
  signal: AbortSignal | undefined,
  urls: string[],
): Promise<void> {
  let lastError: unknown = null;
  for (const [index, url] of urls.entries()) {
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        await downloadFile(url, zipPath, { task, label: release.fileName, signal });
      } catch (err) {
        // 取消不换通道：用户已经不想要这个 JDK 了
        if (signal?.aborted) throw err;
        lastError = err;
        log.warn("JDK 下载失败（" + url + "）：" + (err instanceof Error ? err.message : String(err)));
        break;
      }
      const actualSize = (await stat(zipPath)).size;
      if (release.sha256) {
        const actual = (await sha256Of(zipPath)).toLowerCase();
        if (actual === release.sha256.toLowerCase()) return;
        await rm(zipPath, { force: true });
        lastError = new Error(mt("java.adoptium.checksumFailed", { expected: release.sha256, actual }));
        log.warn("JDK 压缩包 sha256 不一致：" + release.fileName);
        continue;
      }
      const expectedSize = release.sizeBytes && release.sizeBytes > 0 ? release.sizeBytes : 0;
      if (expectedSize === 0 || actualSize === expectedSize) return;
      await rm(zipPath, { force: true });
      lastError = new Error(mt("java.adoptium.sizeFailed", { expected: expectedSize, actual: actualSize }));
      log.warn("JDK 压缩包大小不一致：" + release.fileName);
    }
    if (index < urls.length - 1) log.warn("换下一个下载通道：" + urls[index + 1]);
  }
  throw lastError instanceof Error ? lastError : new Error(mt("java.adoptium.noJavaw", { dir: release.fileName }));
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

const VENDOR_OF: Partial<Record<ManagedSource, string>> = {
  zulu: "Azul Zulu",
  oracle: "Oracle JDK",
  dragonwell: "Alibaba Dragonwell",
};

/** 来源 → 展示用发行方名（写进 .naiwa.json 的 vendor）。 */
export function vendorLabel(source: ManagedSource): string {
  return VENDOR_OF[source] ?? source;
}

/**
 * 装一个 zip 形式的 JDK：已装过就复用，否则下载 → 解压 → 落到 <java>/<source>-<major>-<version>。
 * release.source 必须是具体来源（不含 auto），否则目录名与来源记录都没法写。
 */
export async function installZipRelease(
  release: JavaRelease & { source: ManagedSource },
  signal?: AbortSignal,
  options: ZipInstallOptions = {},
): Promise<InstalledJava> {
  const source = release.source;
  const vendor = vendorLabel(source);
  const paths = getPaths();
  const segment = installDirName(source, release.major, release.version);
  const home = join(paths.java, segment);
  const javawExe = join(home, "bin", "javaw.exe");
  const javaExe = join(home, "bin", "java.exe");

  if (existsSync(javawExe)) {
    // 已装过：补写来源记录（老目录可能没有），直接复用
    await writeSourceRecord(home, {
      source,
      version: release.version,
      installedAt: Date.now(),
      downloadUrl: release.downloadUrl,
    }).catch(() => undefined);
    log.info("JDK " + release.major + " 已存在，复用 " + home);
    return { major: release.major, version: release.version, path: javawExe, vendor, source };
  }

  await mkdir(paths.java, { recursive: true });
  const zipPath = join(paths.downloads, segment + ".zip");
  const task = createTask("java", mt("java.installTitle", { major: release.major, version: release.version }));
  try {
    task.update({ stage: mt("java.stage.download"), percent: 0 });
    const urls = [release.downloadUrl, ...(options.fallbackUrls ?? [])].filter((url) => url.length > 0);
    await downloadVerified(release, zipPath, task, signal, [...new Set(urls)]);

    task.update({ stage: mt("java.stage.extract") });
    const tmp = join(paths.downloads, "unpack", segment + "-" + Date.now());
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    new AdmZip(zipPath).extractAllTo(tmp, true);
    const root = await findJdkRoot(tmp);
    if (!root) throw new Error(mt("java.adoptium.badArchive", { file: release.fileName }));

    await rm(home, { recursive: true, force: true });
    await mkdir(join(home, ".."), { recursive: true });
    await rename(root, home);
    await rm(tmp, { recursive: true, force: true });

    if (!existsSync(javawExe)) throw new Error(mt("java.adoptium.noJavaw", { dir: home }));
    const installedAt = Date.now();
    const meta: JavaMetaFile = {
      major: release.major,
      version: release.version,
      vendor,
      javaExe,
      javawExe,
      installedAt,
      source: release.downloadUrl,
    };
    await writeFile(join(home, ".naiwa.json"), JSON.stringify(meta, null, 2), "utf8");
    await writeSourceRecord(home, {
      source,
      version: release.version,
      installedAt,
      downloadUrl: release.downloadUrl,
    });
    log.info("JDK " + release.major + " 安装完成（" + source + "）：" + home);
    task.done({ major: release.major, version: release.version, path: javawExe });
    return { major: release.major, version: release.version, path: javawExe, vendor, source };
  } catch (err) {
    task.fail(err);
    throw err;
  } finally {
    // 保留 zip 作为下载缓存（续传/重装复用），只清理解压残留
    await rm(join(paths.downloads, "unpack"), { recursive: true, force: true }).catch(() => undefined);
  }
}
