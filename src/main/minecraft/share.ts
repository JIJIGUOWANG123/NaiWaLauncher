// 实例打包 / 导入：把实例目录打成带清单的 .zip 分享给别人，或从别人的 .zip 还原成新实例。
import { app, dialog } from "electron";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import type { InstanceExportResult, InstanceImportResult, InstanceMeta, LoaderKind } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { logger } from "../core/logger";
import { getPaths, instanceDir } from "../core/paths";
import { assertLoaderKind, createInstance, createInstanceRecord, getInstance, listInstances } from "./instances";
import { isVersionInstalled } from "./install";
import { launcherVersion } from "./launch";
import { mt } from "../core/i18n";

const log = logger("share");

/** 压缩包根部的清单文件名：导入时靠它认出「这是 NaiWa 实例包」。 */
const MANIFEST_NAME = "naiwa-instance.json";
const FORMAT_VERSION = 1;
/** 体积大又只对原机器有意义的目录，打包时整目录跳过。 */
const SKIP_TOP_DIRS = new Set(["logs", "crash-reports", "screenshots"]);
/** 实例名上限，与整合包安装保持同一尺度。 */
const MAX_NAME_LEN = 32;

/** 压缩包根部的清单：包内其余内容都是实例目录的镜像。 */
interface InstanceManifest {
  formatVersion: number;
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  createdAt: number;
  fileCount: number;
  launcherVersion: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 默认保存文件名：<实例名>-<mcVersion>.zip，去掉 Windows 不接受的字符。 */
function suggestionFileName(name: string, mcVersion: string): string {
  const base = `${name}-${mcVersion}`
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/[ .]+$/, "");
  return `${base || "instance"}.zip`;
}

/** 默认落在系统下载目录；拿不到（开发态/无 app）就只给文件名。 */
function defaultSavePath(fileName: string): string {
  try {
    return join(app.getPath("downloads"), fileName);
  } catch {
    return fileName;
  }
}

/** 收集实例目录下的文件（相对路径统一用 / 分隔，作为 zip 条目名）。 */
async function collectFiles(root: string): Promise<{ rel: string; abs: string }[]> {
  const files: { rel: string; abs: string }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 只跳过根目录下的这三个：更深的同名目录属于用户自己的资源目录
        if (!rel && SKIP_TOP_DIRS.has(entry.name)) continue;
        await walk(abs, childRel);
        continue;
      }
      // 符号链接等特殊文件不打包：解出来会变成别的路径
      if (!entry.isFile()) continue;
      files.push({ rel: childRel, abs });
    }
  };
  await walk(root, "");
  return files;
}

/** 写压缩包：实例目录内容 + 根部清单，返回落盘后的真实路径与体积。 */
async function writeArchive(
  instance: InstanceMeta,
  root: string,
  target: string,
  task: TaskHandle,
): Promise<InstanceExportResult> {
  task.update({ stage: mt("share.stage.collect"), percent: null });
  const files = await collectFiles(root);
  if (files.length === 0) throw new Error(mt("share.empty", { name: instance.name }));

  const zip = new AdmZip();
  for (const [index, file] of files.entries()) {
    // adm-zip 没有流式写入接口，只能整块读入内存后逐个加条目
    zip.addFile(file.rel, await fs.readFile(file.abs));
    task.update({
      stage: mt("share.stage.pack", { done: index + 1, total: files.length }),
      filesDone: index + 1,
      filesTotal: files.length,
      percent: (index + 1) / files.length,
    });
  }

  const manifest: InstanceManifest = {
    formatVersion: FORMAT_VERSION,
    name: instance.name,
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    ...(instance.loaderVersion ? { loaderVersion: instance.loaderVersion } : {}),
    createdAt: Date.now(),
    fileCount: files.length,
    launcherVersion: launcherVersion(),
  };
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

  task.update({ stage: mt("share.stage.writeArchive"), percent: null });
  await fs.mkdir(dirname(target), { recursive: true });
  try {
    await zip.writeZipPromise(target, { overwrite: true });
  } catch (err) {
    throw new Error(mt("share.writeFailed", { error: messageOf(err) }));
  }
  const sizeBytes = (await fs.stat(target)).size;
  return { path: target, name: instance.name, sizeBytes };
}

/**
 * 导出实例：弹保存框选目标 .zip，打包实例目录（跳过 logs/crash-reports/screenshots）。
 * 用户取消返回 path: null、体积 0。
 */
export async function exportInstance(id: string): Promise<InstanceExportResult> {
  const instance = await getInstance(id);
  if (!instance) throw new Error(mt("inst.notFound", { id }));
  const root = instanceDir(id);
  if (!existsSync(root)) throw new Error(mt("share.dirMissing", { path: root }));

  const picked = await dialog.showSaveDialog({
    title: mt("share.dialogExport"),
    defaultPath: defaultSavePath(suggestionFileName(instance.name, instance.mcVersion)),
    filters: [{ name: mt("share.filterName"), extensions: ["zip"] }],
  });
  if (picked.canceled || !picked.filePath) return { path: null, name: instance.name, sizeBytes: 0 };

  const task = createTask("generic", mt("share.exportTitle", { name: instance.name }));
  try {
    const result = await writeArchive(instance, root, picked.filePath, task);
    task.done(result);
    log.info(`实例「${instance.name}」已导出：${result.path}（${result.sizeBytes} 字节）`);
    return result;
  } catch (err) {
    task.fail(err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 读并校验根部清单：缺失/坏 JSON/未知格式一律按「不是有效的 NaiWa 实例包」拒绝。 */
function readManifest(zipPath: string): InstanceManifest {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    throw new Error(mt("share.badPackageZip", { error: messageOf(err) }));
  }
  const entry = zip.getEntry(MANIFEST_NAME);
  if (!entry) throw new Error(mt("share.badPackageManifest", { file: MANIFEST_NAME }));

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.getData().toString("utf8"));
  } catch (err) {
    throw new Error(mt("share.badPackageJson", { file: MANIFEST_NAME, error: messageOf(err) }));
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(mt("share.badPackageShape", { file: MANIFEST_NAME }));
  }
  const raw = parsed as Partial<InstanceManifest>;
  const formatVersion = Number(raw.formatVersion);
  if (!Number.isFinite(formatVersion)) throw new Error(mt("share.badPackageFormat", { file: MANIFEST_NAME }));
  if (formatVersion > FORMAT_VERSION) {
    throw new Error(mt("share.badPackageTooNew", { format: formatVersion }));
  }
  return { ...raw, formatVersion } as InstanceManifest;
}

/** 清单里的实例名：去控制字符、压掉 Windows 保留字符、截到上限。 */
function validInstanceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/:*?"<>|]/g, "-").trim() : "";
  if (!name) throw new Error(mt("share.badName", { value: typeof raw === "string" ? raw.trim() || mt("common.empty") : mt("common.missing") }));
  return name.slice(0, MAX_NAME_LEN).replace(/[ .]+$/, "") || mt("share.defaultInstanceName");
}

/** 清单里的原版版本号：只允许版本 id 里会出现的字符。 */
function validMcVersion(raw: unknown): string {
  const version = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) {
    throw new Error(mt("share.badMcVersion", { version: version || mt("common.empty") }));
  }
  return version;
}

/** 重名自动追加 " (2)"（3、4…），追加后仍不超过 MAX_NAME_LEN。 */
function uniqueInstanceName(desired: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.trim()));
  if (!used.has(desired)) return desired;
  for (let index = 2; index <= 999; index += 1) {
    const suffix = ` (${index})`;
    const candidate = desired.slice(0, MAX_NAME_LEN - suffix.length).replace(/[ .]+$/, "") + suffix;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(mt("share.nameExhausted", { name: desired }));
}

/** 路径分段：绝对路径、盘符、穿越、控制字符一律拒绝。 */
function entrySegments(raw: string): string[] {
  const text = raw.trim().replace(/\\/g, "/");
  if (!text) throw new Error(mt("core.path.empty"));
  if (text.includes("\u0000")) throw new Error(mt("core.path.controlChar"));
  if (text.startsWith("/")) throw new Error(mt("core.path.absolute"));
  if (/^[A-Za-z]:/.test(text)) throw new Error(mt("core.path.drive"));
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw new Error(mt("core.path.empty"));
  if (segments.some((segment) => segment === "..")) throw new Error(mt("core.path.traversal"));
  return segments;
}

/** 分段拼到根目录下，再复核拼出来的绝对路径仍在根目录里（防 \\?\ 之类漏网写法）。 */
function resolveInside(root: string, segments: string[]): string {
  const dest = join(root, ...segments);
  const base = resolve(root);
  const abs = resolve(dest);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(mt("core.path.escape", { path: segments.join("/") }));
  return dest;
}

/**
 * 解压到临时目录：越界条目逐条拒绝并 warn（不中断导入），落盘范围严格在 targetRoot 内。
 * 清单本身只是元数据，不进实例目录。
 */
async function extractArchive(zipPath: string, targetRoot: string, task: TaskHandle): Promise<{ written: number; rejected: number }> {
  const entries = new AdmZip(zipPath).getEntries();
  let written = 0;
  let rejected = 0;
  for (const [index, entry] of entries.entries()) {
    let dest: string;
    let segments: string[];
    try {
      segments = entrySegments(entry.entryName);
      dest = resolveInside(targetRoot, segments);
    } catch (err) {
      rejected += 1;
      log.warn(`实例包条目被拒绝：${entry.entryName} · ${messageOf(err)}`);
      continue;
    }
    if (segments.length === 1 && segments[0] === MANIFEST_NAME) continue;

    task.update({
      stage: mt("share.stage.unpack", { done: index + 1, total: entries.length }),
      filesDone: index + 1,
      filesTotal: entries.length,
      percent: (index + 1) / entries.length,
    });
    if (entry.isDirectory) {
      await fs.mkdir(dest, { recursive: true });
      continue;
    }
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, entry.getData());
    written += 1;
  }
  return { written, rejected };
}

/** 加载器装好后落在 versions/<id> 的目录名约定（与 loaders/*.ts 保持一致）。 */
function loaderVersionId(mcVersion: string, loader: LoaderKind, loaderVersion?: string): string | undefined {
  switch (loader) {
    case "fabric":
      return `${mcVersion}-fabric`;
    case "quilt":
      return `${mcVersion}-quilt`;
    case "neoforge":
      return `${mcVersion}-neoforge`;
    case "liteloader":
      return `${mcVersion}-liteloader`;
    // forge 的 versionId 带 loaderVersion；清单里没写就只能在 versions 目录里找
    case "forge":
      return loaderVersion ? `${mcVersion}-forge-${loaderVersion}` : undefined;
    default:
      return undefined;
  }
}

async function anyForgeVersion(mcVersion: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(getPaths().versions);
  } catch {
    return undefined;
  }
  const prefix = `${mcVersion}-forge-`;
  for (const entry of entries) {
    if (entry.startsWith(prefix) && (await isVersionInstalled(entry))) return entry;
  }
  return undefined;
}

/**
 * 实例现在能直接启动的 versions 目录 id；undefined 表示原版或加载器还没装。
 * 只认 isVersionInstalled 通过的目录：命中不了就当作没装，宁可多装一次也不让实例指向空目录。
 */
async function installedVersionId(
  mcVersion: string,
  loader: LoaderKind,
  loaderVersion?: string,
): Promise<string | undefined> {
  if (loader === "vanilla") return (await isVersionInstalled(mcVersion)) ? mcVersion : undefined;
  if (loader === "forge" && !loaderVersion) return anyForgeVersion(mcVersion);
  const id = loaderVersionId(mcVersion, loader, loaderVersion);
  if (!id) return undefined;
  return (await isVersionInstalled(id)) ? id : undefined;
}

/**
 * 导入实例：选 .zip → 解压到临时目录 → 校验清单 → 建实例（缺原版/加载器就补装）→ 内容搬进实例目录。
 * 任何一步失败都保留已经建好的实例（用户能在列表里看到并删除），临时目录始终清理。
 */
export async function importInstance(): Promise<InstanceImportResult> {
  const picked = await dialog.showOpenDialog({
    title: mt("share.dialogImport"),
    properties: ["openFile"],
    filters: [{ name: mt("share.filterName"), extensions: ["zip"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { instanceId: null, name: "" };

  const zipPath = picked.filePaths[0];
  const manifest = readManifest(zipPath);
  const desiredName = validInstanceName(manifest.name);
  const mcVersion = validMcVersion(manifest.mcVersion);
  const loader = assertLoaderKind(manifest.loader);
  const loaderVersion = typeof manifest.loaderVersion === "string" ? manifest.loaderVersion.trim() || undefined : undefined;
  const name = uniqueInstanceName(desiredName, (await listInstances()).map((instance) => instance.name));

  const task = createTask("generic", mt("share.importTitle", { name }));
  const tempDir = await fs.mkdtemp(join(tmpdir(), "naiwa-instance-"));
  let created: InstanceMeta | undefined;
  try {
    task.update({ stage: mt("share.stage.extractArchive"), percent: null });
    const extracted = await extractArchive(zipPath, tempDir, task);
    if (extracted.rejected > 0) log.warn(`实例包「${desiredName}」有 ${extracted.rejected} 个越界条目被拒绝，其余内容照常导入`);

    // 原版 + 加载器目录都齐了才走快路（不碰网络/安装器），否则交给 createInstance 补装
    const vanillaReady = await isVersionInstalled(mcVersion);
    const versionId = vanillaReady ? await installedVersionId(mcVersion, loader, loaderVersion) : undefined;

    let instance: InstanceMeta;
    if (versionId === undefined) {
      task.update({
        stage: loader === "vanilla" ? mt("share.stage.installVanilla", { version: mcVersion }) : mt("share.stage.installLoader", { loader, version: loaderVersion ?? "" }).trim(),
        percent: null,
      });
      instance = await createInstance({
        name,
        mcVersion,
        loader,
        ...(loaderVersion ? { loaderVersion } : {}),
      });
    } else {
      instance = await createInstanceRecord({
        name,
        mcVersion,
        loader,
        ...(loaderVersion ? { loaderVersion } : {}),
        versionId,
      });
    }
    created = instance;

    task.update({ stage: mt("share.stage.writeInstance"), percent: null });
    await fs.cp(tempDir, instanceDir(instance.id), { recursive: true });

    const result: InstanceImportResult = {
      instanceId: instance.id,
      name: instance.name,
      ...(versionId === undefined ? { installedMissing: true } : {}),
    };
    task.done(result);
    log.info(
      mt("share.importDone", { name: instance.name, id: instance.id, mc: instance.mcVersion, loader: instance.loader + (instance.loaderVersion ? " " + instance.loaderVersion : ""), extra: versionId === undefined ? mt("share.importLoaderPatched") : "" }),
    );
    return result;
  } catch (err) {
    task.fail(err);
    const reason = messageOf(err);
    throw new Error(
      created
        ? mt("share.importFailedKept", { reason, name: created.name, id: created.id })
        : mt("share.importFailed", { reason }),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn(`导入临时目录清理失败：${tempDir} · ${messageOf(err)}`);
    });
  }
}
