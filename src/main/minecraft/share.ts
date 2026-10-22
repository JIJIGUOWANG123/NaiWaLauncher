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

const log = logger("share");

/** 压缩包根部的清单文件名：导入时靠它认出「这是 NaiWa 实例包」。 */
const MANIFEST_NAME = "naiwa-instance.json";
const FORMAT_VERSION = 1;
/** 体积大又只对原机器有意义的目录，打包时整目录跳过。 */
const SKIP_TOP_DIRS = new Set(["logs", "crash-reports", "screenshots"]);
/** 实例名上限，与整合包安装保持同一尺度。 */
const MAX_NAME_LEN = 32;
/** 兜底版本号（与 package.json 同步维护）。 */
const LAUNCHER_VERSION_FALLBACK = "0.1.3";

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

function launcherVersion(): string {
  try {
    const version = app?.getVersion?.();
    // 开发态（node 直跑脚本）拿到的是 Electron 版本，不是启动器版本
    if (version && version !== process.versions.electron) return version;
  } catch {
    /* 忽略：没有 electron app 时用兜底版本 */
  }
  return LAUNCHER_VERSION_FALLBACK;
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
  task.update({ stage: "收集实例文件", percent: null });
  const files = await collectFiles(root);
  if (files.length === 0) throw new Error(`实例「${instance.name}」没有任何可打包的文件`);

  const zip = new AdmZip();
  for (const [index, file] of files.entries()) {
    // adm-zip 没有流式写入接口，只能整块读入内存后逐个加条目
    zip.addFile(file.rel, await fs.readFile(file.abs));
    task.update({
      stage: `打包 ${index + 1}/${files.length}`,
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

  task.update({ stage: "写入压缩包", percent: null });
  await fs.mkdir(dirname(target), { recursive: true });
  try {
    await zip.writeZipPromise(target, { overwrite: true });
  } catch (err) {
    throw new Error(`压缩包写入失败：${messageOf(err)}`);
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
  if (!instance) throw new Error(`实例不存在：${id}`);
  const root = instanceDir(id);
  if (!existsSync(root)) throw new Error(`实例目录不存在：${root}`);

  const picked = await dialog.showSaveDialog({
    title: "导出实例",
    defaultPath: defaultSavePath(suggestionFileName(instance.name, instance.mcVersion)),
    filters: [{ name: "实例压缩包", extensions: ["zip"] }],
  });
  if (picked.canceled || !picked.filePath) return { path: null, name: instance.name, sizeBytes: 0 };

  const task = createTask("generic", `导出实例 ${instance.name}`);
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
    throw new Error(`不是有效的 NaiWa 实例包：压缩包打不开（${messageOf(err)}）`);
  }
  const entry = zip.getEntry(MANIFEST_NAME);
  if (!entry) throw new Error(`不是有效的 NaiWa 实例包：压缩包根部缺少 ${MANIFEST_NAME}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.getData().toString("utf8"));
  } catch (err) {
    throw new Error(`不是有效的 NaiWa 实例包：${MANIFEST_NAME} 不是合法 JSON（${messageOf(err)}）`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`不是有效的 NaiWa 实例包：${MANIFEST_NAME} 内容不是对象`);
  }
  const raw = parsed as Partial<InstanceManifest>;
  const formatVersion = Number(raw.formatVersion);
  if (!Number.isFinite(formatVersion)) throw new Error(`不是有效的 NaiWa 实例包：${MANIFEST_NAME} 缺少 formatVersion`);
  if (formatVersion > FORMAT_VERSION) {
    throw new Error(`不是有效的 NaiWa 实例包：formatVersion ${formatVersion} 需要更新版本的启动器`);
  }
  return { ...raw, formatVersion } as InstanceManifest;
}

/** 清单里的实例名：去控制字符、压掉 Windows 保留字符、截到上限。 */
function validInstanceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/:*?"<>|]/g, "-").trim() : "";
  if (!name) throw new Error(`实例包里的实例名不合法：${typeof raw === "string" ? raw.trim() || "（空）" : "（缺失）"}`);
  return name.slice(0, MAX_NAME_LEN).replace(/[ .]+$/, "") || "导入实例";
}

/** 清单里的原版版本号：只允许版本 id 里会出现的字符。 */
function validMcVersion(raw: unknown): string {
  const version = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) {
    throw new Error(`实例包里的 Minecraft 版本不合法：${version || "（空）"}`);
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
  throw new Error(`实例名「${desired}」的重名序号已用尽，请换个名字`);
}

/** 路径分段：绝对路径、盘符、穿越、控制字符一律拒绝。 */
function entrySegments(raw: string): string[] {
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

/** 分段拼到根目录下，再复核拼出来的绝对路径仍在根目录里（防 \\?\ 之类漏网写法）。 */
function resolveInside(root: string, segments: string[]): string {
  const dest = join(root, ...segments);
  const base = resolve(root);
  const abs = resolve(dest);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`路径越界：${segments.join("/")}`);
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
      stage: `解压 ${index + 1}/${entries.length}`,
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
    title: "导入实例",
    properties: ["openFile"],
    filters: [{ name: "实例压缩包", extensions: ["zip"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { instanceId: null, name: "" };

  const zipPath = picked.filePaths[0];
  const manifest = readManifest(zipPath);
  const desiredName = validInstanceName(manifest.name);
  const mcVersion = validMcVersion(manifest.mcVersion);
  const loader = assertLoaderKind(manifest.loader);
  const loaderVersion = typeof manifest.loaderVersion === "string" ? manifest.loaderVersion.trim() || undefined : undefined;
  const name = uniqueInstanceName(desiredName, (await listInstances()).map((instance) => instance.name));

  const task = createTask("generic", `导入实例 ${name}`);
  const tempDir = await fs.mkdtemp(join(tmpdir(), "naiwa-instance-"));
  let created: InstanceMeta | undefined;
  try {
    task.update({ stage: "解压压缩包", percent: null });
    const extracted = await extractArchive(zipPath, tempDir, task);
    if (extracted.rejected > 0) log.warn(`实例包「${desiredName}」有 ${extracted.rejected} 个越界条目被拒绝，其余内容照常导入`);

    // 原版 + 加载器目录都齐了才走快路（不碰网络/安装器），否则交给 createInstance 补装
    const vanillaReady = await isVersionInstalled(mcVersion);
    const versionId = vanillaReady ? await installedVersionId(mcVersion, loader, loaderVersion) : undefined;

    let instance: InstanceMeta;
    if (versionId === undefined) {
      task.update({
        stage: loader === "vanilla" ? `安装原版 ${mcVersion}` : `安装加载器 ${loader} ${loaderVersion ?? ""}`.trim(),
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

    task.update({ stage: "写入实例目录", percent: null });
    await fs.cp(tempDir, instanceDir(instance.id), { recursive: true });

    const result: InstanceImportResult = {
      instanceId: instance.id,
      name: instance.name,
      ...(versionId === undefined ? { installedMissing: true } : {}),
    };
    task.done(result);
    log.info(
      `实例「${instance.name}」导入完成（${instance.id}）：${instance.mcVersion} / ${instance.loader}${
        instance.loaderVersion ? " " + instance.loaderVersion : ""
      }${versionId === undefined ? " · 已补装缺失的原版/加载器" : ""}`,
    );
    return result;
  } catch (err) {
    task.fail(err);
    const reason = messageOf(err);
    throw new Error(
      created
        ? `导入实例失败：${reason}；已新建的实例「${created.name}」（${created.id}）保留，可在实例列表里删除`
        : `导入实例失败：${reason}`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn(`导入临时目录清理失败：${tempDir} · ${messageOf(err)}`);
    });
  }
}
