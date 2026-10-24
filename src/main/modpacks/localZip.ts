// 第三方启动器（CurseForge / Modrinth / MultiMC·Prism / HMCL）给的整合包压缩包：
// 只读 zip 中央目录识别格式，再复用现有实例、加载器、下载链路把包里的内容装进一个新实例。
//
// 为什么不「先整包解压再找清单」：243MB / 11451 条目的包解一次就是一份磁盘副本加一分钟的 IO，
// 而识别只需要根目录里的几个小 JSON；overrides 也只解一遍。
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import type { ModpackZipInfo, ModpackZipInstallResult } from "../../shared/ipc";
import type { InstanceMeta, LoaderKind } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { downloadMany } from "../core/http";
import { mt } from "../core/i18n";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { installLoader } from "../loaders/index";
import { createInstanceRecord, gameDirOf, listInstances } from "../minecraft/instances";
import { installVersion, isVersionInstalled } from "../minecraft/install";
import { curseforgeProvider } from "../mods/curseforge";
import { safeFileName } from "../mods/install";
import {
  cleanInstanceName, parseModpackIndex, planModpackFetches, safeModpackPath, uniqueInstanceName,
} from "../mods/modpack";
import {
  jsonArray, jsonIdString, jsonObject, jsonString, mapLimit, messageOf,
} from "../mods/provider";

const log = logger("modpackzip");

/** 四种格式各自靠根目录里的哪个文件认出来。 */
const CF_MANIFEST = "manifest.json";
const MODRINTH_INDEX = "modrinth.index.json";
const MMC_PACK = "mmc-pack.json";
const MMC_CONFIG = "instance.cfg";
const HMCL_MANIFEST = "modpack.json";

/** CurseForge 的条目只有 projectID/fileID，每个都要问一次来源：6 路并发够快也不至于被限流。 */
const RESOLVE_CONCURRENCY = 6;
/** 解压 overrides 的并行度上限：条目是整块读进内存的，别把大包一次性摊开。 */
const EXTRACT_SLOTS = 8;
/** 包内模组落到实例的 mods 目录。 */
const MODS_DIR_NAME = "mods";

type ZipEntry = AdmZip.IZipEntry;

interface OpenedZip {
  zip: AdmZip;
  entries: ZipEntry[];
  /** 根目录条目（key 为小写名）：清单只可能在这里，别去猜嵌套目录。 */
  root: Map<string, ZipEntry>;
}

function normalizedName(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** 磁盘写满这类底层错误换成用户能行动的原因，别把 ENOSPC 原样甩给界面。 */
function readableReason(err: unknown): string {
  const raw = messageOf(err);
  if (/ENOSPC|no space left on device|disk full/i.test(raw)) return mt("modpack.zip.noSpace");
  return raw;
}

/** 打开 zip 并建立根目录索引；损坏的包在这里换成可读错误。 */
function openZip(zipPath: string): OpenedZip {
  if (!existsSync(zipPath)) throw new Error(mt("modpack.zip.missing", { path: zipPath }));
  if (!statSync(zipPath).isFile()) throw new Error(mt("modpack.zip.notFile", { path: zipPath }));

  let zip: AdmZip;
  let entries: ZipEntry[];
  try {
    zip = new AdmZip(zipPath);
    entries = zip.getEntries();
  } catch (err) {
    throw new Error(mt("modpack.zip.notZip", { path: zipPath, error: messageOf(err) }));
  }

  const root = new Map<string, ZipEntry>();
  for (const entry of entries) {
    const name = normalizedName(entry.entryName);
    if (!name || name.includes("/")) continue;
    root.set(name.toLowerCase(), entry);
  }
  return { zip, entries, root };
}

/** 读根目录里的一个 JSON：损坏与缺字段都给可读原因，不吞异常。 */
function readJson(zip: AdmZip, entry: ZipEntry, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = entry.getData().toString("utf8");
  } catch (err) {
    throw new Error(mt("modpack.zip.manifestUnreadable", { file: label, error: messageOf(err) }));
  }
  try {
    return jsonObject(JSON.parse(text));
  } catch (err) {
    throw new Error(mt("modpack.zip.manifestBadJson", { file: label, error: messageOf(err) }));
  }
}

/** CurseForge 的加载器 id 形如 neoforge-21.1.133 / forge-47.2.0 / fabric-0.16.5。 */
function parseLoaderId(raw: string): { loader: LoaderKind; version?: string } | null {
  const matched = /^(neoforge|forge|fabric|quilt|liteloader)[-_](.+)$/i.exec(raw.trim());
  if (!matched) return null;
  const loader = matched[1].toLowerCase() as LoaderKind;
  const version = matched[2].trim();
  return { loader, ...(version ? { version } : {}) };
}

/** MultiMC/Prism 的组件 uid → 加载器。 */
const MMC_LOADERS: Record<string, LoaderKind> = {
  "net.fabricmc.fabric-loader": "fabric",
  "net.minecraftforge": "forge",
  "net.neoforged": "neoforge",
  "org.quiltmc.quilt-loader": "quilt",
};

/** 识别不出来时的统一出口：格式留 unsupported，原因一定带内容。 */
function unsupported(zipPath: string, sizeBytes: number, reason: string): ModpackZipInfo {
  return {
    format: "unsupported",
    name: baseNameOf(zipPath),
    version: "",
    mcVersion: "",
    loader: "vanilla",
    fileCount: 0,
    overridesDir: null,
    sizeBytes,
    installable: false,
    reason,
  };
}

function baseNameOf(zipPath: string): string {
  const name = basename(zipPath).replace(/\.zip$/i, "").trim();
  return name || basename(zipPath);
}

function inspectCurseForge(zip: AdmZip, entry: ZipEntry, zipPath: string, sizeBytes: number): ModpackZipInfo {
  const manifest = readJson(zip, entry, CF_MANIFEST);
  const minecraft = jsonObject(manifest.minecraft);
  const mcVersion = jsonString(minecraft.version).trim();
  if (!mcVersion) throw new Error(mt("modpack.zip.mcVersionMissing", { file: CF_MANIFEST }));

  // 多个加载器时以 primary 为准（CurseForge 用 primary 标记真正要装的那个）
  const declared = jsonArray(minecraft.modLoaders).map(jsonObject);
  const primary = declared.find((item) => item.primary === true) ?? declared[0];
  const rawLoaderId = primary ? jsonIdString(primary.id).trim() : "";
  const parsed = rawLoaderId ? parseLoaderId(rawLoaderId) : null;
  if (rawLoaderId && !parsed) throw new Error(mt("modpack.zip.loaderUnsupported", { loader: rawLoaderId }));

  const overrides = jsonString(manifest.overrides).trim();
  return {
    format: "curseforge",
    name: cleanInstanceName(jsonString(manifest.name).trim() || baseNameOf(zipPath)),
    version: jsonString(manifest.version).trim(),
    mcVersion,
    loader: parsed?.loader ?? "vanilla",
    ...(parsed?.version ? { loaderVersion: parsed.version } : {}),
    fileCount: jsonArray(manifest.files).length,
    overridesDir: overrides || "overrides",
    sizeBytes,
    installable: true,
  };
}

function inspectModrinth(zip: AdmZip, entry: ZipEntry, zipPath: string, sizeBytes: number): ModpackZipInfo {
  const raw = readJson(zip, entry, MODRINTH_INDEX);
  // 解析规则与在线安装完全一致：缺 dependencies.minecraft 或声明多个加载器时抛同样的可读错误
  const index = parseModpackIndex(raw);
  return {
    format: "modrinth",
    name: cleanInstanceName(jsonString(raw.name).trim() || baseNameOf(zipPath)),
    version: jsonString(raw.versionId).trim(),
    mcVersion: index.mcVersion,
    loader: index.loader,
    ...(index.loaderVersion ? { loaderVersion: index.loaderVersion } : {}),
    fileCount: index.files.length,
    overridesDir: "overrides",
    sizeBytes,
    installable: true,
  };
}

/** MultiMC/Prism 的实例名写在 instance.cfg 里（name=xxx）。 */
function readMmcName(zip: AdmZip, entry: ZipEntry | undefined): string {
  if (!entry) return "";
  try {
    const matched = /^\s*name\s*=(.*)$/im.exec(entry.getData().toString("utf8"));
    return matched ? matched[1].trim() : "";
  } catch {
    return "";
  }
}

function inspectMultiMc(zip: AdmZip, packEntry: ZipEntry, cfgEntry: ZipEntry | undefined, zipPath: string, sizeBytes: number): ModpackZipInfo {
  const pack = readJson(zip, packEntry, MMC_PACK);
  const components = jsonArray(pack.components).map(jsonObject);
  const find = (uid: string) => components.find((item) => jsonString(item.uid).trim().toLowerCase() === uid);
  const mcVersion = jsonString(find("net.minecraft")?.version).trim();
  const loaderComponent = components.find((item) => MMC_LOADERS[jsonString(item.uid).trim().toLowerCase()] !== undefined);
  const loader = loaderComponent ? MMC_LOADERS[jsonString(loaderComponent.uid).trim().toLowerCase()] : "vanilla";
  const loaderVersion = loaderComponent ? jsonString(loaderComponent.version).trim() : "";
  return {
    format: "multimc",
    name: cleanInstanceName(readMmcName(zip, cfgEntry) || baseNameOf(zipPath)),
    version: "",
    mcVersion,
    loader,
    ...(loaderVersion ? { loaderVersion } : {}),
    fileCount: 0,
    overridesDir: null,
    sizeBytes,
    installable: false,
    reason: mt("modpack.zip.formatNotInstallable", { format: "MultiMC / Prism" }),
  };
}

function inspectHmcl(zip: AdmZip, entry: ZipEntry, zipPath: string, sizeBytes: number): ModpackZipInfo {
  const raw = readJson(zip, entry, HMCL_MANIFEST);
  const minecraft = jsonObject(raw.minecraft);
  const mcVersion = jsonString(raw.gameVersion).trim() || jsonString(minecraft.version).trim();
  return {
    format: "hmcl",
    name: cleanInstanceName(jsonString(raw.name).trim() || baseNameOf(zipPath)),
    version: jsonString(raw.version).trim(),
    mcVersion,
    loader: "vanilla",
    fileCount: jsonArray(raw.files).length,
    overridesDir: null,
    sizeBytes,
    installable: false,
    reason: mt("modpack.zip.formatNotInstallable", { format: "HMCL" }),
  };
}

/**
 * 只读中央目录识别整合包：返回格式与元信息，不解压任何条目。
 * 认不出来就返回 format=unsupported + 可读原因（含缺哪些清单），不硬猜。
 */
export function inspectModpackZip(zipPath: string): ModpackZipInfo {
  const opened = openZip(zipPath);
  const sizeBytes = statSync(zipPath).size;
  const at = (name: string): ZipEntry | undefined => opened.root.get(name.toLowerCase());
  const isEmpty = opened.entries.length === 0;

  const cf = at(CF_MANIFEST);
  if (cf) return inspectCurseForge(opened.zip, cf, zipPath, sizeBytes);
  const modrinth = at(MODRINTH_INDEX);
  if (modrinth) return inspectModrinth(opened.zip, modrinth, zipPath, sizeBytes);
  const mmc = at(MMC_PACK);
  if (mmc) return inspectMultiMc(opened.zip, mmc, at(MMC_CONFIG), zipPath, sizeBytes);
  const hmcl = at(HMCL_MANIFEST);
  if (hmcl) return inspectHmcl(opened.zip, hmcl, zipPath, sizeBytes);

  return unsupported(
    zipPath,
    sizeBytes,
    isEmpty
      ? mt("modpack.zip.emptyArchive", { file: basename(zipPath) })
      : mt("modpack.zip.unsupported", { file: basename(zipPath), entries: String(opened.entries.length) }),
  );
}

/** CurseForge manifest 里真正要装的条目：projectID/fileID 缺一个就跳过。 */
interface CfFileRef {
  projectId: string;
  fileId: string;
  required: boolean;
}

function curseForgeFileRefs(zip: AdmZip, entry: ZipEntry): CfFileRef[] {
  const manifest = readJson(zip, entry, CF_MANIFEST);
  const refs: CfFileRef[] = [];
  for (const item of jsonArray(manifest.files)) {
    const file = jsonObject(item);
    const projectId = jsonIdString(file.projectID ?? file.projectId).trim();
    const fileId = jsonIdString(file.fileID ?? file.fileId).trim();
    if (!projectId || !fileId) continue;
    refs.push({ projectId, fileId, required: file.required !== false });
  }
  return refs;
}

/** 包内路径拼到实例目录下，并复核结果仍在目录里（沿用整合包安装的防穿越规则）。 */
function resolveInside(root: string, segments: string[]): string {
  const dest = join(root, ...segments);
  const base = resolve(root);
  const abs = resolve(dest);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(mt("core.path.escape", { path: segments.join("/") }));
  return dest;
}

/** 同名文件撞车时追加 " (2)"，不能悄悄丢掉一个模组。 */
function uniqueDest(taken: Set<string>, dir: string, fileName: string): string {
  const suffix = /\.jar$/i.test(fileName) ? fileName.slice(-4) : "";
  const base = suffix ? fileName.slice(0, -4) : fileName;
  let dest = join(dir, fileName);
  for (let index = 2; taken.has(dest.toLowerCase()); index += 1) dest = join(dir, `${base} (${index})${suffix}`);
  taken.add(dest.toLowerCase());
  return dest;
}

/** 下载进度的 stage 文本要跟着文件进度走：任务面板显示的是 stage，不是数字。 */
function poolTaskOf(task: TaskHandle, stage: (done: number, total: number) => string, total: number): TaskHandle {
  return {
    ...task,
    update: (patch) => {
      const filesTotal = patch.filesTotal ?? total;
      const withStage = typeof patch.filesDone === "number" && filesTotal > 0
        ? { ...patch, stage: stage(patch.filesDone, filesTotal) }
        : patch;
      task.update(withStage);
    },
  };
}

interface FileStats {
  downloaded: number;
  failed: { path: string; reason: string }[];
}

/** CurseForge：projectID/fileID 逐个问来源（无 Key 时 curseforge provider 自动走 MCIM 镜像）→ 下载进 mods。 */
async function installCurseForgeFiles(
  opened: OpenedZip,
  root: string,
  task: TaskHandle,
  opts: { limit?: number; signal?: AbortSignal },
): Promise<FileStats> {
  const entry = opened.root.get(CF_MANIFEST.toLowerCase());
  if (!entry) throw new Error(mt("modpack.zip.manifestMissing", { file: CF_MANIFEST }));
  const refs = curseForgeFileRefs(opened.zip, entry);
  const optional = refs.filter((ref) => !ref.required).length;
  if (optional > 0) log.info(`整合包里有 ${optional} 个可选文件，按默认配置不装`);
  const wanted = refs.filter((ref) => ref.required);
  const limited = typeof opts.limit === "number" && opts.limit > 0 ? wanted.slice(0, opts.limit) : wanted;
  if (limited.length < wanted.length) log.warn(`按 limit=${opts.limit} 只装前 ${limited.length}/${wanted.length} 个文件（自检模式）`);

  const modsDir = join(root, MODS_DIR_NAME);
  await mkdir(modsDir, { recursive: true });

  let resolvedDone = 0;
  const failed: { path: string; reason: string }[] = [];
  const resolved = await mapLimit(limited, RESOLVE_CONCURRENCY, async (ref) => {
    const label = `${ref.projectId}/${ref.fileId}`;
    try {
      const file = await curseforgeProvider.getFile(ref.projectId, ref.fileId);
      return { label, fileName: file.info.fileName, url: file.info.downloadUrl, ...(file.sha1 ? { sha1: file.sha1 } : {}), ...(file.size ? { size: file.size } : {}) };
    } catch (err) {
      failed.push({ path: label, reason: messageOf(err) });
      return null;
    } finally {
      resolvedDone += 1;
      task.update({ stage: mt("modpack.zip.stage.resolveFiles", { done: resolvedDone, total: limited.length }), filesDone: resolvedDone, filesTotal: limited.length });
    }
  });

  const taken = new Set<string>();
  const items: { url: string; dest: string; sha1?: string; size?: number; label: string }[] = [];
  for (const item of resolved) {
    if (!item) continue;
    let dest: string;
    try {
      dest = uniqueDest(taken, modsDir, safeFileName(item.fileName));
    } catch (err) {
      failed.push({ path: item.label, reason: messageOf(err) });
      continue;
    }
    items.push({ url: item.url, dest, label: `${MODS_DIR_NAME}/${basename(dest)}`, ...(item.sha1 ? { sha1: item.sha1 } : {}), ...(item.size ? { size: item.size } : {}) });
  }

  const settings = getSettings();
  const downloaded = await downloadInto(items, task, settings, opts.signal, failed);
  return { downloaded, failed };
}

/** Modrinth：index 里已经给了 path 与直链，沿用在线安装的路径校验与并发下载。 */
async function installModrinthFiles(
  opened: OpenedZip,
  root: string,
  task: TaskHandle,
  opts: { limit?: number; signal?: AbortSignal },
): Promise<FileStats> {
  const entry = opened.root.get(MODRINTH_INDEX.toLowerCase());
  if (!entry) throw new Error(mt("modpack.zip.manifestMissing", { file: MODRINTH_INDEX }));
  const index = parseModpackIndex(readJson(opened.zip, entry, MODRINTH_INDEX));
  const limited = typeof opts.limit === "number" && opts.limit > 0 ? index.files.slice(0, opts.limit) : index.files;
  const plan = planModpackFetches(limited, root);
  const failed: { path: string; reason: string }[] = [];
  for (const rejection of plan.rejected) {
    failed.push({ path: rejection.path, reason: rejection.reason });
    log.warn(`整合包条目被拒绝：${rejection.path} · ${rejection.reason}`);
  }
  const items = plan.jobs.map((job) => ({ url: job.url, dest: job.dest, label: job.path, ...(job.sha1 ? { sha1: job.sha1 } : {}) }));
  const settings = getSettings();
  const downloaded = await downloadInto(items, task, settings, opts.signal, failed);
  return { downloaded, failed };
}

/** 统一下载：走现有 downloadMany 并发池，进度按「已完成/总数」写回 stage。 */
async function downloadInto(
  items: { url: string; dest: string; sha1?: string; size?: number; label: string }[],
  task: TaskHandle,
  settings: { concurrentDownloads: number; connectionsPerFile: number },
  signal: AbortSignal | undefined,
  failed: { path: string; reason: string }[],
): Promise<number> {
  if (items.length === 0) {
    task.update({ stage: mt("modpack.zip.stage.downloadFiles", { done: 0, total: 0 }), filesDone: 0, filesTotal: 0 });
    return 0;
  }
  const labelByDest = new Map(items.map((item) => [item.dest, item.label] as const));
  const toDownload = (list: typeof items) => list.map((item) => ({
    url: item.url,
    dest: item.dest,
    ...(item.sha1 ? { sha1: item.sha1 } : {}),
    ...(item.size ? { size: item.size } : {}),
  }));

  task.update({ stage: mt("modpack.zip.stage.downloadFiles", { done: 0, total: items.length }), filesDone: 0, filesTotal: items.length, percent: null });
  const first = await downloadMany(toDownload(items), {
    task: poolTaskOf(task, (done, total) => mt("modpack.zip.stage.downloadFiles", { done, total }), items.length),
    label: mt("modpack.zip.downloadLabel"),
    concurrent: settings.concurrentDownloads,
    connections: settings.connectionsPerFile,
    ...(signal ? { signal } : {}),
  });

  // 失败的再补一轮：CDN 在整包并发的冷启动下会偶发 404/5xx，补一次能救回大半（重跑验过 200）；
  // 这一轮把并发压到很低，避免又是一轮风暴。
  let errors = first.failed;
  let ok = Math.max(0, items.length - errors.length);
  if (errors.length > 0) {
    const retry = items.filter((item) => errors.some((err) => err.dest === item.dest));
    log.warn(`整合包有 ${retry.length} 个文件首次下载失败，低于并发重试一次`);
    task.update({ stage: mt("modpack.zip.stage.retryFiles", { done: 0, total: retry.length }), filesDone: 0, filesTotal: retry.length });
    const second = await downloadMany(toDownload(retry), {
      task: poolTaskOf(task, (done, total) => mt("modpack.zip.stage.retryFiles", { done, total }), retry.length),
      label: mt("modpack.zip.retryLabel"),
      concurrent: Math.min(2, retry.length),
      connections: 1,
      ...(signal ? { signal } : {}),
    });
    ok += Math.max(0, retry.length - second.failed.length);
    errors = second.failed;
  }

  for (const item of errors) {
    failed.push({ path: labelByDest.get(item.dest) ?? item.dest, reason: item.error });
    log.warn(`整合包文件下载失败：${labelByDest.get(item.dest) ?? item.dest} · ${item.error}`);
  }
  return ok;
}

/**
 * overrides 原样解到实例目录（保留相对路径、不跳过任何目录：运行时垃圾也不该由启动器替用户筛）。
 * 越界条目逐条拒绝并 warn，绝不写到实例目录之外。
 */
async function extractOverrides(
  zip: AdmZip,
  root: string,
  prefix: string | null,
  task: TaskHandle,
  concurrent: number,
): Promise<{ written: number; rejected: number }> {
  if (!prefix) return { written: 0, rejected: 0 };
  const base = normalizedName(prefix);
  if (!base) return { written: 0, rejected: 0 };
  const head = `${base}/`;

  const entries = zip
    .getEntries()
    .filter((entry) => normalizedName(entry.entryName).startsWith(head))
    .filter((entry) => normalizedName(entry.entryName).slice(head.length).trim().length > 0);
  const total = entries.length;
  if (total === 0) return { written: 0, rejected: 0 };

  const slots = Math.max(1, Math.min(concurrent, EXTRACT_SLOTS, total));
  let cursor = 0;
  let done = 0;
  let written = 0;
  let rejected = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const entry = entries[index];
      const rest = normalizedName(entry.entryName).slice(head.length);
      let dest: string | null = null;
      try {
        dest = resolveInside(root, safeModpackPath(rest));
      } catch (err) {
        rejected += 1;
        log.warn(`overrides 条目被拒绝：${entry.entryName} · ${messageOf(err)}`);
      }
      if (dest !== null) {
        if (entry.isDirectory) {
          await mkdir(dest, { recursive: true });
        } else {
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, entry.getData());
          written += 1;
        }
      }
      done += 1;
      task.update({ stage: mt("mods.pack.stage.unpackOverrides", { done, total }), filesDone: done, filesTotal: total });
    }
  };

  await Promise.all(Array.from({ length: slots }, () => worker()));
  return { written, rejected };
}

export interface ModpackZipInstallOptions {
  /** 实例名；缺省用包里的整合包名（重名自动加后缀）。 */
  instanceName?: string;
  /** 只装包内前 N 个文件（自检/排障用；缺省装全部）。 */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * 完整安装：识别 → 建实例名 → 原版 + 加载器（installLoader）→ 包内文件下载进 mods →
 * overrides 解压进实例目录。任一步失败都保留已建好的实例，不悄悄回滚用户能看到的东西。
 */
export async function installModpackZip(
  zipPath: string,
  opts: ModpackZipInstallOptions = {},
): Promise<ModpackZipInstallResult> {
  const info = inspectModpackZip(zipPath);
  if (!info.installable) {
    throw new Error(info.reason ?? mt("modpack.zip.unsupported", { file: basename(zipPath), entries: "0" }));
  }
  const desired = opts.instanceName?.trim() || info.name;
  const name = uniqueInstanceName(desired, (await listInstances()).map((instance) => instance.name));

  const task = createTask("mod", mt("mods.pack.installTitle", { name }));
  let instance: InstanceMeta | undefined;
  try {
    // 原版已装就跳过（10k+ 个 assets 的重复核验不值得）：加载器安装自己也会补原版
    if (!(await isVersionInstalled(info.mcVersion))) {
      task.update({ stage: mt("mods.pack.stage.installVanilla", { version: info.mcVersion }), percent: null });
      await installVersion(info.mcVersion, opts.signal);
    }

    let versionId = info.mcVersion;
    let loaderVersion = info.loaderVersion;
    if (info.loader !== "vanilla") {
      const loaderLabel = info.loader + (info.loaderVersion ? ` ${info.loaderVersion}` : "");
      task.update({ stage: mt("mods.pack.stage.installLoader", { loader: loaderLabel }), percent: null });
      const installed = await installLoader({
        mcVersion: info.mcVersion,
        loader: info.loader,
        ...(info.loaderVersion ? { loaderVersion: info.loaderVersion } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      versionId = installed.versionId;
      loaderVersion = installed.loaderVersion;
    }

    task.update({ stage: mt("modpack.zip.stage.createInstance", { name }), percent: null });
    instance = await createInstanceRecord({
      name,
      mcVersion: info.mcVersion,
      loader: info.loader,
      ...(loaderVersion ? { loaderVersion } : {}),
      versionId,
    });

    const root = gameDirOf(instance);
    const opened = openZip(zipPath);
    task.update({ stage: mt("modpack.zip.stage.parseManifest"), percent: null });
    const stats = info.format === "curseforge"
      ? await installCurseForgeFiles(opened, root, task, opts)
      : await installModrinthFiles(opened, root, task, opts);

    task.update({ stage: mt("modpack.zip.stage.extractOverrides"), percent: null });
    const overrides = await extractOverrides(opened.zip, root, info.overridesDir, task, getSettings().concurrentDownloads);
    if (overrides.rejected > 0) log.warn(`overrides 里有 ${overrides.rejected} 个越界条目被拒绝，其余内容照常解压`);

    const result: ModpackZipInstallResult = {
      instanceId: instance.id,
      name: instance.name,
      mcVersion: instance.mcVersion,
      loader: instance.loader,
      ...(instance.loaderVersion ? { loaderVersion: instance.loaderVersion } : {}),
      format: info.format,
      downloaded: stats.downloaded,
      failed: stats.failed,
      overridesExtracted: overrides.written,
    };
    task.done(result);
    log.info(
      mt("modpack.zip.done", {
        name: instance.name, id: instance.id, format: info.format,
        done: stats.downloaded, total: info.fileCount, overrides: overrides.written,
      }),
    );
    return result;
  } catch (err) {
    const reason = readableReason(err);
    task.fail(err);
    const kept = instance ? mt("mods.pack.instanceKept", { name: instance.name, id: instance.id }) : "";
    throw new Error(mt("modpack.zip.installFailed", { reason, kept }));
  }
}
