// 整合包一键安装：Modrinth .mrpack → 新实例（原版 + 加载器）→ index 里的文件 → overrides。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import type { InstanceMeta, LoaderKind } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { downloadFile, downloadMany } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { installLoader } from "../loaders/index";
import { createInstanceRecord, gameDirOf, listInstances } from "../minecraft/instances";
import { installVersion } from "../minecraft/install";
import {
  bestFile, FILE_LIMIT_MAX, jsonArray, jsonObject, jsonString, messageOf,
  type ModProvider, type ResolvedFile,
} from "./provider";
import { safeFileName } from "./install";

const log = logger("modpack");

/** mrpack 规范：索引文件名与覆盖目录前缀。 */
const INDEX_NAME = "modrinth.index.json";
const OVERRIDES_PREFIX = "overrides/";
/** 实例名上限（Windows 文件名与界面列表都按这个尺度）。 */
const MAX_INSTANCE_NAME = 32;

/** 索引里的 files[] 条目：path 是相对实例游戏目录的路径。 */
export interface ModpackFile {
  path: string;
  url: string;
  sha1?: string;
}

/** modrinth.index.json 里安装真正需要的部分。 */
export interface ModpackIndex {
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  files: ModpackFile[];
}

/** 索引依赖键 → 加载器；按声明顺序取第一个（一个整合包只会声明一个）。 */
const LOADER_KEYS: { key: string; loader: LoaderKind }[] = [
  { key: "fabric-loader", loader: "fabric" },
  { key: "forge", loader: "forge" },
  { key: "neoforge", loader: "neoforge" },
  { key: "quilt-loader", loader: "quilt" },
];

/**
 * 解析 modrinth.index.json：游戏版本、加载器、文件清单。
 * 缺 dependencies.minecraft 就不是可安装的整合包；同时声明多个加载器也不替用户猜。
 */
export function parseModpackIndex(raw: unknown): ModpackIndex {
  const root = jsonObject(raw);
  const deps = jsonObject(root.dependencies);
  const mcVersion = jsonString(deps.minecraft).trim();
  if (!mcVersion) throw new Error("整合包缺少 dependencies.minecraft，无法确定游戏版本");

  const declared = LOADER_KEYS
    .map((entry) => ({ ...entry, version: jsonString(deps[entry.key]).trim() }))
    .filter((entry) => entry.version.length > 0);
  if (declared.length > 1) {
    throw new Error(`整合包同时声明了多个加载器（${declared.map((entry) => entry.key).join("、")}），无法确定该装哪个`);
  }

  const files: ModpackFile[] = [];
  let skipped = 0;
  for (const entry of jsonArray(root.files)) {
    const file = jsonObject(entry);
    const path = jsonString(file.path).trim();
    const url = jsonArray(file.downloads).map(jsonString).map((value) => value.trim()).find((value) => value.length > 0);
    // 没有路径或没有下载地址的条目（服务端专属、空值）跳过并计数，不静默吞掉
    if (!path || !url) {
      skipped += 1;
      continue;
    }
    const sha1 = jsonString(jsonObject(file.hashes).sha1).trim();
    files.push({ path, url, ...(sha1 ? { sha1 } : {}) });
  }
  if (skipped > 0) log.warn(`整合包索引里 ${skipped} 个条目缺少路径或下载地址，已跳过`);

  const head = declared[0];
  return {
    mcVersion,
    loader: head ? head.loader : "vanilla",
    ...(head && head.version ? { loaderVersion: head.version } : {}),
    files,
  };
}

/** 路径分段里不允许出现的东西：绝对路径、盘符、穿越、NUL。 */
export function safeModpackPath(raw: string): string[] {
  const text = raw.trim().replace(/\\/g, "/");
  if (!text) throw new Error("路径为空");
  if (text.includes("\u0000")) throw new Error("路径含控制字符");
  if (text.startsWith("/")) throw new Error("绝对路径");
  if (/^[A-Za-z]:/.test(text)) throw new Error("盘符路径");
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw new Error("路径为空");
  if (segments.some((segment) => segment === "..")) throw new Error("含目录穿越（..）");
  return segments;
}

/** 分段拼到根目录下，并复核拼出来的绝对路径仍在根目录里（防 \\?\ 之类的漏网写法）。 */
function resolveInside(root: string, segments: string[]): string {
  const dest = join(root, ...segments);
  const base = resolve(root);
  const abs = resolve(dest);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`路径越界：${segments.join("/")}`);
  return dest;
}

/** 一次待下载：dest 已解析成实例游戏目录下的绝对路径。 */
export interface ModpackFetch {
  path: string;
  url: string;
  dest: string;
  sha1?: string;
}

export interface ModpackPlan {
  jobs: ModpackFetch[];
  rejected: { path: string; reason: string }[];
}

/** 纯函数：索引条目 → 下载清单；非法路径在这里就被挡在盘外，不产生 dest。 */
export function planModpackFetches(files: ModpackFile[], root: string): ModpackPlan {
  const jobs: ModpackFetch[] = [];
  const rejected: { path: string; reason: string }[] = [];
  for (const file of files) {
    try {
      const dest = resolveInside(root, safeModpackPath(file.path));
      jobs.push({ path: file.path, url: file.url, dest, ...(file.sha1 ? { sha1: file.sha1 } : {}) });
    } catch (err) {
      rejected.push({ path: file.path, reason: messageOf(err) });
    }
  }
  return { jobs, rejected };
}

/** 实例名清洗：去首尾空白、压掉控制字符与 Windows 保留字符、截到 32 字符。 */
export function cleanInstanceName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/:*?"<>|]/g, "-").trim();
  // 先按字符截断再收尾：把截断处的空格与点去掉，避免名字以空格结尾
  return name.slice(0, MAX_INSTANCE_NAME).replace(/[ .]+$/, "") || "整合包";
}

/** 重名自动追加 " (2)"（3、4…）：追加后仍不超过 32 字符。 */
export function uniqueInstanceName(desired: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim());
  const base = cleanInstanceName(desired);
  if (!used.has(base)) return base;
  for (let index = 2; index <= 999; index += 1) {
    const suffix = ` (${index})`;
    const candidate = base.slice(0, MAX_INSTANCE_NAME - suffix.length).replace(/[ .]+$/, "") + suffix;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`实例名「${base}」的重名序号已用尽，请换个名字`);
}

/** 实例游戏目录里现有的实例名（重名判定用）。 */
async function takenInstanceNames(): Promise<string[]> {
  const instances = await listInstances();
  return instances.map((instance) => instance.name);
}

/** .mrpack 落盘名：沿用远端文件名，但必须是单级且带 .mrpack 后缀。 */
function modpackFileName(raw: string): string {
  const name = safeFileName(raw);
  return /\.mrpack$/i.test(name) ? name : `${name}.mrpack`;
}

/** 未指定 fileId 时挑最佳 .mrpack：先掐掉非 mrpack 文件，再走现有五档匹配（无目标版本/加载器 → 取最新）。 */
async function pickModpackFile(provider: ModProvider, projectId: string, fileId?: string): Promise<ResolvedFile> {
  if (fileId) {
    const resolved = await provider.getFile(projectId, fileId);
    if (!/\.mrpack$/i.test(resolved.info.fileName)) {
      throw new Error(`所选文件不是 .mrpack（${resolved.info.fileName}），无法一键安装`);
    }
    if (!/\.mrpack$/i.test(resolved.info.downloadUrl)) log.warn(`文件 ${resolved.info.fileName} 的下载地址不以 .mrpack 结尾，仍按整合包解析`);
    return resolved;
  }

  const files = await provider.listFiles({ provider: provider.id, projectId, kind: "modpack", limit: FILE_LIMIT_MAX });
  const packs = files.filter((file) => /\.mrpack$/i.test(file.fileName));
  if (packs.length === 0) {
    throw new Error(`整合包 ${projectId} 没有 .mrpack 文件（Modrinth 整合包格式），无法一键安装`);
  }
  const best = bestFile(packs);
  if (!best) throw new Error(`整合包 ${projectId} 的文件列表为空`);
  log.info(`整合包 ${projectId} 选中文件 ${best.fileName}（${best.fileId}）`);
  return provider.getFile(projectId, best.fileId);
}

/** 从 .mrpack 里读索引：缺索引说明不是 mrpack 或下载被截断。 */
function readIndex(mrpackPath: string): unknown {
  const zip = new AdmZip(mrpackPath);
  const entry = zip.getEntry(INDEX_NAME);
  if (!entry) throw new Error(`${INDEX_NAME} 缺失：这不是有效的 .mrpack 整合包`);
  try {
    return JSON.parse(entry.getData().toString("utf8"));
  } catch (err) {
    throw new Error(`${INDEX_NAME} 不是合法 JSON：${messageOf(err)}`);
  }
}

/**
 * overrides/ 解到游戏目录，非法条目逐条拒绝并 warn（不落盘到根目录之外）。
 * 用固定数量的 worker 并行解压落盘：几十个条目逐个 await 只是排队等 I/O，并行后按并发数缩短。
 */
async function extractOverrides(
  mrpackPath: string,
  root: string,
  task: TaskHandle,
  concurrent: number,
): Promise<{ written: number; rejected: number }> {
  const zip = new AdmZip(mrpackPath);
  // 目录自身（overrides/）没有内容可写，先剔掉再算总数，进度分母才是真实条目数
  const entries = zip
    .getEntries()
    .filter((entry) => entry.entryName.startsWith(OVERRIDES_PREFIX))
    .filter((entry) => entry.entryName.slice(OVERRIDES_PREFIX.length).replace(/[\\/]+$/, "").trim().length > 0);
  const total = entries.length;
  // 解压是全内存展开：并行度额外压到 8，避免大整合包一次性把条目全读进内存
  const slots = Math.max(1, Math.min(concurrent, 8, total));
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
      const rest = entry.entryName.slice(OVERRIDES_PREFIX.length);
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
      task.update({ stage: `解压 overrides ${done}/${total}`, filesDone: done, filesTotal: total });
    }
  };

  await Promise.all(Array.from({ length: slots }, () => worker()));
  return { written, rejected };
}

export interface ModpackEntityStats {
  downloaded: number;
  failed: { path: string; reason: string }[];
  rejected: { path: string; reason: string }[];
  overridesWritten: number;
  overridesRejected: number;
}

/**
 * 把索引里的文件与 overrides 落到已存在的实例游戏目录里。
 * 单个文件下载失败只记 warn 并继续（一个坏链接不该让整包白装），失败清单交给调用方。
 */
export async function installModpackEntities(
  instance: InstanceMeta,
  index: ModpackIndex,
  mrpackPath: string,
  task: TaskHandle,
  signal?: AbortSignal,
): Promise<ModpackEntityStats> {
  const root = gameDirOf(instance);
  const plan = planModpackFetches(index.files, root);
  for (const rejection of plan.rejected) {
    log.warn(`整合包条目被拒绝：${rejection.path} · ${rejection.reason}`);
  }

  const settings = getSettings();
  const total = plan.jobs.length;
  const pathByDest = new Map(plan.jobs.map((job) => [job.dest, job.path] as const));
  task.update({ stage: `下载整合包模组 0/${total}`, filesDone: 0, filesTotal: total, percent: null });

  // 池子只报 filesDone/filesTotal，而任务面板显示的是 stage 文本：把「已完成/总数」写回 stage，
  // 界面上的进度仍是「下载整合包模组 n/总数」，且不是每个文件一个任务。
  const poolTask: TaskHandle = {
    ...task,
    update: (patch) => {
      const totalFiles = patch.filesTotal ?? total;
      const withStage =
        typeof patch.filesDone === "number" && totalFiles > 0
          ? { ...patch, stage: `下载整合包模组 ${patch.filesDone}/${totalFiles}` }
          : patch;
      task.update(withStage);
    },
  };

  // 整包的几十个文件走 downloadMany 的并发池同时下载，并发读设置里的 concurrentDownloads。
  const { failed: errors } = await downloadMany(
    plan.jobs.map((job) => ({ url: job.url, dest: job.dest, ...(job.sha1 ? { sha1: job.sha1 } : {}) })),
    {
      task: poolTask,
      label: "下载整合包模组",
      concurrent: settings.concurrentDownloads,
      connections: settings.connectionsPerFile,
      ...(signal ? { signal } : {}),
    },
  );
  // 单个文件失败只 warn 继续（一个坏链接不该让整包白装），失败清单原样交给调用方
  const failed = errors.map((item) => ({ path: pathByDest.get(item.dest) ?? item.dest, reason: item.error }));
  for (const item of failed) log.warn(`整合包文件下载失败：${item.path} · ${item.reason}`);
  const downloaded = Math.max(0, total - failed.length);

  task.update({ stage: `解压 overrides（${downloaded}/${total} 个文件已下载）`, percent: null });
  const overrides = await extractOverrides(mrpackPath, root, task, settings.concurrentDownloads);
  return {
    downloaded,
    failed,
    rejected: plan.rejected,
    overridesWritten: overrides.written,
    overridesRejected: overrides.rejected,
  };
}

export interface ModpackInstallRequest {
  projectId: string;
  fileId?: string;
  instanceName?: string;
}

export interface ModpackInstallResult {
  instanceId: string;
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  /** .mrpack 落盘文件名（NaiWa/downloads 里）。 */
  modpackFile: string;
  filesTotal: number;
  filesDownloaded: number;
  filesRejected: number;
  filesFailed: { path: string; reason: string }[];
  overridesWritten: number;
}

/**
 * 一键安装：挑 .mrpack → 下载到 NaiWa/downloads → 解析索引 → 装原版与加载器 → 建实例 → 装文件与 overrides。
 * 失败时把已经建好的实例留在原地（说明里带上名字），绝不悄悄回滚用户能看到的东西。
 */
export async function installModpackFrom(
  provider: ModProvider,
  req: ModpackInstallRequest,
  signal?: AbortSignal,
): Promise<ModpackInstallResult> {
  const resolved = await pickModpackFile(provider, req.projectId, req.fileId);
  const project = await provider.getProject?.(req.projectId);
  const desired = req.instanceName?.trim() || project?.title?.trim() || req.projectId;
  const name = uniqueInstanceName(desired, await takenInstanceNames());

  const task = createTask("mod", `安装整合包 ${name}`);
  let instance: InstanceMeta | undefined;
  try {
    task.update({ stage: "下载整合包", percent: null });
    const fileName = modpackFileName(resolved.info.fileName);
    const mrpackPath = join(getPaths().downloads, fileName);
    await mkdir(getPaths().downloads, { recursive: true });
    await downloadFile(resolved.info.downloadUrl, mrpackPath, {
      task,
      ...(resolved.sha1 ? { expectedSha1: resolved.sha1 } : {}),
      connections: getSettings().connectionsPerFile,
      label: fileName,
      signal,
    });

    task.update({ stage: "解析整合包索引", percent: null });
    const index = parseModpackIndex(readIndex(mrpackPath));
    log.info(
      `整合包 ${name}：Minecraft ${index.mcVersion} / ${index.loader}${index.loaderVersion ? " " + index.loaderVersion : ""} · ${index.files.length} 个文件`,
    );

    task.update({ stage: `安装原版 ${index.mcVersion}`, percent: null });
    await installVersion(index.mcVersion, signal);

    let versionId = index.mcVersion;
    let loaderVersion = index.loaderVersion;
    if (index.loader !== "vanilla") {
      task.update({ stage: `安装加载器 ${index.loader}${index.loaderVersion ? " " + index.loaderVersion : ""}`, percent: null });
      const installed = await installLoader({
        mcVersion: index.mcVersion,
        loader: index.loader,
        loaderVersion: index.loaderVersion,
        signal,
      });
      versionId = installed.versionId;
      loaderVersion = installed.loaderVersion;
    }

    instance = await createInstanceRecord({
      name,
      mcVersion: index.mcVersion,
      loader: index.loader,
      ...(loaderVersion ? { loaderVersion } : {}),
      versionId,
    });

    const stats = await installModpackEntities(instance, index, mrpackPath, task, signal);
    if (stats.failed.length > 0) {
      log.warn(
        `整合包 ${name} 有 ${stats.failed.length} 个文件没下完：${stats.failed.map((item) => item.path).join("、")}；实例已建好，可稍后重装补齐`,
      );
    }
    if (index.files.length > 0 && stats.downloaded === 0) {
      throw new Error(`整合包里 ${index.files.length} 个文件全部下载失败（${stats.failed[0]?.reason ?? "未知原因"}）`);
    }

    const result: ModpackInstallResult = {
      instanceId: instance.id,
      name: instance.name,
      mcVersion: instance.mcVersion,
      loader: instance.loader,
      ...(instance.loaderVersion ? { loaderVersion: instance.loaderVersion } : {}),
      modpackFile: fileName,
      filesTotal: stats.downloaded + stats.failed.length + stats.rejected.length,
      filesDownloaded: stats.downloaded,
      filesRejected: stats.rejected.length,
      filesFailed: stats.failed,
      overridesWritten: stats.overridesWritten,
    };
    task.done(result);
    log.info(
      `整合包 ${name} 安装完成：实例 ${instance.id} · 文件 ${stats.downloaded}/${index.files.length} · overrides ${stats.overridesWritten} 个`,
    );
    return result;
  } catch (err) {
    const reason = messageOf(err);
    task.fail(err);
    const kept = instance ? `实例「${instance.name}」（${instance.id}）已创建，可在列表里继续使用；` : "";
    throw new Error(`整合包安装失败：${reason}（${kept}已下载的 .mrpack 保留在 NaiWa\\downloads）`);
  }
}
