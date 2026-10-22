import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { createTask } from "../core/events";
import { downloadFile, downloadMany } from "../core/http";
import { logger } from "../core/logger";
import { getPaths, versionDir } from "../core/paths";
import { getSettings } from "../core/settings";
import { mavenPathOf, nativesClassifierAllowed, rulesAllow } from "./args";
import { getVanillaJson } from "./manifest";

const log = logger("install");

// 资源对象的官方地址前缀；core/http 会按设置映射到镜像
const RESOURCES_BASE = "https://resources.download.minecraft.net";
const LIBRARIES_BASE = "https://libraries.minecraft.net/";

interface DownloadItem {
  url: string;
  dest: string;
  sha1?: string;
  size?: number;
}

interface PendingNatives {
  zipPath: string;
  exclude: string[];
}

async function sha1Of(file: string): Promise<string> {
  const hash = createHash("sha1");
  const stream = createReadStream(file);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function fileMatches(file: string, sha1?: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  if (!sha1) return true;
  try {
    return (await sha1Of(file)) === sha1;
  } catch {
    return false;
  }
}

/**
 * 只以 versions/<id>/<id>.json + <id>.jar 为准：这两个文件在，游戏就有本体可启动。
 * libraries / assets 由 installVersion 幂等补齐，缺失时启动会失败但可以再装一次修好；
 * 因此这里刻意不做全量校验（那要把上千个文件逐个 stat，界面每次刷新都会卡）。
 */
export async function isVersionInstalled(versionId: string): Promise<boolean> {
  const dir = versionDir(versionId);
  return existsSync(join(dir, `${versionId}.json`)) && existsSync(join(dir, `${versionId}.jar`));
}

function fail(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 安装器阶段一：客户端 jar 与 log4j 配置。 */
async function installClient(json: any, versionId: string, dir: string, signal?: AbortSignal): Promise<void> {
  const task = createTask("game", `安装 ${versionId}`);
  try {
    const client = json.downloads?.client;
    if (!client?.url) throw new Error(`${versionId} 的版本 JSON 缺少客户端下载地址`);
    const jarPath = join(dir, `${versionId}.jar`);
    task.update({ stage: "客户端 jar", filesTotal: 1, filesDone: 0, percent: null });
    if (await fileMatches(jarPath, client.sha1)) {
      task.update({ stage: "客户端 jar（已存在）", filesDone: 1, percent: 1 });
    } else {
      await downloadFile(client.url, jarPath, { task, expectedSha1: client.sha1, label: `${versionId}.jar`, signal });
      task.update({ stage: "客户端 jar", filesDone: 1, percent: 1 });
    }

    // log4j 配置是可选文件：缺了游戏会用内置默认配置照常启动，
    // 但下载失败不能把整个安装判失败（否则镜像缺对象时玩家装不上游戏）。
    const logFile = json.logging?.client?.file;
    if (logFile?.url) {
      const dest = join(getPaths().assets, "log_configs", String(logFile.id ?? `${versionId}-client.xml`));
      try {
        if (!(await fileMatches(dest, logFile.sha1))) {
          task.update({ stage: "log4j 配置" });
          await downloadFile(logFile.url, dest, {
            task,
            expectedSha1: logFile.sha1,
            label: String(logFile.id ?? "log_config"),
            signal,
          });
        }
      } catch (logConfigError) {
        // 取消不能被"log4j 可忽略"这条规则吞掉
        if (signal?.aborted) throw logConfigError;
        log.warn(
          `log4j 配置下载失败，游戏将使用内置默认日志配置：${logFile.id ?? "log_config"} · ${logConfigError instanceof Error ? logConfigError.message : String(logConfigError)}`,
        );
      }
    }
    task.done({ versionId });
  } catch (err) {
    task.fail(err);
    throw fail(err);
  }
}

/** 1.18 及更早用 natives 分类器 + 解压；1.19 起原生库直接进 classpath。 */
function nativesClassifier(lib: any): string | null {
  const key = lib?.natives?.windows;
  if (!key) return null;
  return String(key).replace("${arch}", "64");
}

async function extractNatives(pending: PendingNatives, nativesDir: string): Promise<void> {
  if (!existsSync(pending.zipPath)) {
    log.warn(`缺少原生库压缩包：${pending.zipPath}`);
    return;
  }
  const zip = new AdmZip(pending.zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    // Windows 只需要 dll，签名与清单文件忽略
    if (!/\.dll$/i.test(name)) continue;
    if (pending.exclude.some((pattern) => name.startsWith(pattern))) continue;
    const dest = join(nativesDir, name);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, entry.getData());
  }
}

function collectLibraries(json: any): { items: DownloadItem[]; natives: PendingNatives[] } {
  const paths = getPaths();
  const items: DownloadItem[] = [];
  const natives: PendingNatives[] = [];
  const seenDest = new Set<string>();

  const push = (item: DownloadItem): void => {
    if (seenDest.has(item.dest)) return;
    seenDest.add(item.dest);
    items.push(item);
  };

  for (const lib of Array.isArray(json.libraries) ? json.libraries : []) {
    if (!rulesAllow(lib?.rules)) continue;
    if (!nativesClassifierAllowed(String(lib?.name ?? ""))) continue;
    const classifier = nativesClassifier(lib);
    if (classifier) {
      const native = lib.downloads?.classifiers?.[classifier];
      if (native?.url && native?.path) {
        const dest = join(paths.libraries, String(native.path));
        push({ url: String(native.url), dest, sha1: native.sha1, size: native.size });
        natives.push({ zipPath: dest, exclude: Array.isArray(lib.extract?.exclude) ? lib.extract.exclude.map(String) : [] });
      } else {
        log.warn(`原生库 ${lib.name ?? classifier} 缺少 classifiers 下载信息`);
      }
    }

    const artifact = lib.downloads?.artifact;
    if (artifact?.url && artifact?.path) {
      push({ url: String(artifact.url), dest: join(paths.libraries, String(artifact.path)), sha1: artifact.sha1, size: artifact.size });
      continue;
    }
    if (classifier || !lib.name) continue;
    // 老版本 JSON 无 downloads 字段：按 Maven 坐标拼地址
    const rel = mavenPathOf(String(lib.name));
    const base = typeof lib.url === "string" && lib.url.length > 0 ? lib.url : LIBRARIES_BASE;
    push({ url: base.endsWith("/") ? base + rel : `${base}/${rel}`, dest: join(paths.libraries, rel) });
  }
  return { items, natives };
}

/** 安装器阶段二：依赖库与原生库解压。 */
async function installLibraries(json: any, versionId: string, dir: string, signal?: AbortSignal): Promise<string> {
  const settings = getSettings();
  const nativesDir = join(dir, "natives");
  const { items, natives } = collectLibraries(json);
  const task = createTask("libraries", `下载 ${versionId} 依赖库`);

  try {
    task.update({ stage: "依赖库", filesTotal: items.length, filesDone: 0, percent: 0 });
    const { failed } = await downloadMany(items, {
      task,
      concurrent: settings.concurrentDownloads,
      connections: settings.connectionsPerFile,
      label: "libraries",
      signal,
    });
    if (failed.length > 0) {
      throw new Error(`依赖库下载失败 ${failed.length} 个，首个：${failed[0].url}（${failed[0].error}）`);
    }

    await fs.mkdir(nativesDir, { recursive: true });
    for (const pending of natives) await extractNatives(pending, nativesDir);

    task.update({ stage: "依赖库", filesDone: items.length, filesTotal: items.length, percent: 1 });
    task.done({ libraries: items.length, natives: natives.length });
    return nativesDir;
  } catch (err) {
    task.fail(err);
    throw fail(err);
  }
}

/** 安装器阶段三：资源索引与 objects（按 hash 去重，已存在直接跳过）。 */
async function installAssets(json: any, versionId: string, signal?: AbortSignal): Promise<void> {
  const paths = getPaths();
  const settings = getSettings();
  const task = createTask("assets", `下载 ${versionId} 资源文件`);

  try {
    const indexMeta = json.assetIndex;
    if (!indexMeta?.url || !indexMeta?.id) {
      task.update({ stage: "该版本无资源索引", percent: 1 });
      task.done({ objects: 0 });
      return;
    }

    const indexPath = join(paths.assetIndexes, `${indexMeta.id}.json`);
    task.update({ stage: "资源索引", filesTotal: 1, filesDone: 0, percent: 0 });
    if (!(await fileMatches(indexPath, indexMeta.sha1))) {
      await downloadFile(String(indexMeta.url), indexPath, {
        task,
        expectedSha1: indexMeta.sha1,
        label: `${indexMeta.id}.json`,
        signal,
      });
    }

    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
      objects?: Record<string, { hash: string; size: number }>;
      virtual?: boolean;
      map_to_resources?: boolean;
    };
    if (index.virtual || index.map_to_resources) {
      log.warn(`${indexMeta.id} 是旧版虚拟资源索引，仅下载 objects`);
    }

    const objects = Object.values(index.objects ?? {});
    const pending: DownloadItem[] = [];
    const seenHash = new Set<string>();
    for (const object of objects) {
      if (!object?.hash || seenHash.has(object.hash)) continue;
      seenHash.add(object.hash);
      const prefix = object.hash.slice(0, 2);
      const dest = join(paths.assetObjects, prefix, object.hash);
      if (existsSync(dest)) continue;
      pending.push({ url: `${RESOURCES_BASE}/${prefix}/${object.hash}`, dest, sha1: object.hash, size: object.size });
    }

    task.update({ stage: "资源文件", filesTotal: objects.length, filesDone: objects.length - pending.length, percent: 0 });
    if (pending.length > 0) {
      const { failed } = await downloadMany(pending, {
        task,
        concurrent: settings.concurrentDownloads,
        connections: settings.connectionsPerFile,
        label: "assets",
        signal,
      });
      if (failed.length > 0) {
        throw new Error(`资源文件下载失败 ${failed.length} 个，首个：${failed[0].url}（${failed[0].error}）`);
      }
    }

    task.update({ stage: "资源文件", filesDone: objects.length, filesTotal: objects.length, percent: 1 });
    task.done({ objects: seenHash.size });
  } catch (err) {
    task.fail(err);
    throw fail(err);
  }
}

/**
 * 安装一个版本。
 * signal 被 cancel 时所有下载立刻中断并抛「下载已取消」，已下好的文件与续传记录都会保留。
 */
export async function installVersion(mcVersion: string, signal?: AbortSignal): Promise<{ versionId: string }> {
  const json = await getVanillaJson(mcVersion);
  const paths = getPaths();
  const dir = versionDir(mcVersion);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(paths.libraries, { recursive: true });
  await fs.mkdir(paths.assetIndexes, { recursive: true });
  await fs.mkdir(paths.assetObjects, { recursive: true });
  await fs.writeFile(join(dir, `${mcVersion}.json`), JSON.stringify(json, null, 2), "utf8");

  await installClient(json, mcVersion, dir, signal);
  await installLibraries(json, mcVersion, dir, signal);
  await installAssets(json, mcVersion, signal);

  log.info(`${mcVersion} 安装完成`);
  return { versionId: mcVersion };
}
