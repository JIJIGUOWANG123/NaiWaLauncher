import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CreateInstanceRequest } from "../../shared/ipc";
import type { InstanceMeta, LoaderKind, SaveInfo } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths, instanceDir, instanceModsDir, versionDir } from "../core/paths";
import { getSettings } from "../core/settings";
import { installLoader } from "../loaders/index";
import { installVersion, isVersionInstalled } from "./install";

const log = logger("instances");

const DEFAULT_MEMORY_MB = 2048;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function instanceFile(id: string): string {
  return join(getPaths().instances, `${id}.json`);
}

function isSafeId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function slugOf(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return ascii.length > 0 ? ascii : "inst";
}

async function uniqueInstanceId(name: string): Promise<string> {
  const slug = slugOf(name);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = randomBytes(3).toString("hex");
    const id = `${slug}-${suffix}`;
    if (!existsSync(instanceFile(id)) && !existsSync(instanceDir(id))) return id;
  }
  throw new Error("实例 id 生成失败，请重试");
}

async function readMeta(id: string): Promise<InstanceMeta | null> {
  if (!isSafeId(id)) return null;
  try {
    const raw = await fs.readFile(instanceFile(id), "utf8");
    const meta = JSON.parse(raw) as InstanceMeta;
    if (!meta || typeof meta.id !== "string") return null;
    return meta;
  } catch {
    return null;
  }
}

async function writeMeta(meta: InstanceMeta): Promise<void> {
  await fs.mkdir(getPaths().instances, { recursive: true });
  const file = instanceFile(meta.id);
  // 先写临时文件再改名，避免界面读到半个 JSON
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function sortInstances(list: InstanceMeta[]): InstanceMeta[] {
  return list.sort((a, b) => {
    const played = (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0);
    if (played !== 0) return played;
    return b.createdAt - a.createdAt;
  });
}

export async function listInstances(): Promise<InstanceMeta[]> {
  const dir = getPaths().instances;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas: InstanceMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const meta = await readMeta(entry.slice(0, -".json".length));
    if (meta) metas.push(meta);
    else log.warn(`实例文件损坏，已跳过：${entry}`);
  }
  return sortInstances(metas);
}

export async function getInstance(id: string): Promise<InstanceMeta | undefined> {
  const meta = await readMeta(id);
  return meta ?? undefined;
}

export async function createInstance(req: CreateInstanceRequest, signal?: AbortSignal): Promise<InstanceMeta> {
  const name = String(req.name ?? "").trim();
  if (name.length === 0) throw new Error("实例名称不能为空");
  const mcVersion = String(req.mcVersion ?? "").trim();
  if (mcVersion.length === 0) throw new Error("请选择 Minecraft 版本");
  const loader: LoaderKind = req.loader ?? "vanilla";

  // 先装原版：加载器要基于已存在的原版版本 JSON 生成差异 JSON
  await installVersion(mcVersion, signal);

  let versionId = mcVersion;
  let loaderVersion = req.loaderVersion;
  if (loader !== "vanilla") {
    const installed = await installLoader({ mcVersion, loader, loaderVersion: req.loaderVersion, signal });
    versionId = installed.versionId;
    loaderVersion = installed.loaderVersion;
  }

  const id = await uniqueInstanceId(name);
  await fs.mkdir(instanceModsDir(id), { recursive: true });
  const memoryMb = req.memoryMb && req.memoryMb > 0 ? Math.round(req.memoryMb) : DEFAULT_MEMORY_MB;
  const meta: InstanceMeta = {
    id,
    name,
    mcVersion,
    loader,
    ...(loaderVersion ? { loaderVersion } : {}),
    versionId,
    memoryMb,
    extraJvmArgs: "",
    createdAt: Date.now(),
  };
  await writeMeta(meta);
  log.info(`实例「${name}」创建完成（${id}），版本 ${versionId}`);
  return meta;
}

export async function updateInstance(id: string, patch: Partial<InstanceMeta>): Promise<InstanceMeta> {
  const current = await getInstance(id);
  if (!current) throw new Error(`实例不存在：${id}`);
  const next: InstanceMeta = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
  if (typeof next.name !== "string" || next.name.trim().length === 0) next.name = current.name;
  await writeMeta(next);
  return next;
}

const LOADER_KINDS: readonly LoaderKind[] = ["vanilla", "fabric", "forge", "neoforge", "quilt", "liteloader"];

function assertLoaderKind(loader: unknown): LoaderKind {
  if (typeof loader !== "string" || !LOADER_KINDS.includes(loader as LoaderKind)) {
    throw new Error(`未知的加载器类型：${String(loader)}`);
  }
  return loader as LoaderKind;
}

/** 删除切换后不再使用的旧加载器版本目录。原版目录（versions/<mcVersion>）永不删除。 */
async function dropUnusedVersionDir(oldVersionId: string, mcVersion: string): Promise<void> {
  if (oldVersionId === mcVersion) return;
  const all = await listInstances();
  // 任一实例的 mcVersion 都是原版目录；任一实例仍在用的 versionId 也不能删
  if (all.some((m) => m.versionId === oldVersionId || m.mcVersion === oldVersionId)) {
    log.info(`旧版本 ${oldVersionId} 仍被其他实例引用，保留`);
    return;
  }
  try {
    await fs.rm(versionDir(oldVersionId), { recursive: true, force: true });
    log.info(`已清理旧加载器版本目录 versions/${oldVersionId}`);
  } catch (err) {
    log.warn(`清理旧加载器版本 ${oldVersionId} 失败：${(err as Error).message}`);
  }
}

/**
 * 切换实例加载器：先装新加载器，成功后才改元数据并清理旧版本目录；实例游戏目录不动。
 * 注意：fabric/neoforge 的 versionId 不含 loaderVersion（loaders 侧约定），同加载器换 loaderVersion 时
 * versionId 不变、旧目录也就不会被清理；本模块不支持同一实例并存多个 loaderVersion。
 */
export async function setLoader(
  id: string,
  loader: LoaderKind,
  loaderVersion?: string,
  signal?: AbortSignal,
): Promise<InstanceMeta> {
  const kind = assertLoaderKind(loader);
  const current = await getInstance(id);
  if (!current) throw new Error(`实例不存在：${id}`);

  const wanted = kind === "vanilla" ? undefined : (loaderVersion ?? "").trim() || undefined;

  // 先装：安装失败就整体放弃，元数据保持原样（不做半切换）
  let nextVersionId = current.mcVersion;
  let nextLoaderVersion: string | undefined;
  if (kind !== "vanilla") {
    let installed: { versionId: string; loaderVersion: string };
    try {
      installed = await installLoader({ mcVersion: current.mcVersion, loader: kind, loaderVersion: wanted, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `切换加载器失败：${kind}${wanted ? " " + wanted : ""} 未安装成功（${reason}）；实例仍是 ${current.loader}（${current.versionId}）`,
      );
    }
    nextVersionId = installed.versionId;
    nextLoaderVersion = installed.loaderVersion;
  } else if (!(await isVersionInstalled(current.mcVersion))) {
    // 原版目录可能被用户手工删掉：切回 vanilla 前补装，避免实例指向不存在的版本
    log.warn(`原版 ${current.mcVersion} 目录缺失，切回 vanilla 前自动补装`);
    try {
      await installVersion(current.mcVersion, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `切换加载器失败：原版 ${current.mcVersion} 补装失败（${reason}）；实例仍是 ${current.loader}（${current.versionId}）`,
      );
    }
  }

  const next: InstanceMeta = { ...current, loader: kind, versionId: nextVersionId };
  if (nextLoaderVersion) next.loaderVersion = nextLoaderVersion;
  else delete next.loaderVersion;

  try {
    await writeMeta(next);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`切换加载器失败：实例元数据写入失败（${reason}）；实例仍是 ${current.loader}（${current.versionId}）`);
  }

  // 元数据落盘后才清理旧目录：先删再写会让写盘失败时无版本可用
  if (current.versionId && current.versionId !== nextVersionId) {
    await dropUnusedVersionDir(current.versionId, current.mcVersion);
  }

  log.info(`实例 ${current.name}（${current.id}）加载器切换：${current.versionId} → ${nextVersionId}`);
  return next;
}

export async function deleteInstance(id: string): Promise<void> {
  if (!isSafeId(id)) throw new Error(`非法实例 id：${id}`);
  const current = await readMeta(id);
  await fs.rm(instanceFile(id), { force: true });
  await fs.rm(instanceDir(id), { recursive: true, force: true });
  log.info(`实例已删除：${current?.name ?? id}`);
}

/** 统计存档体积时最多数这么多文件：大存档动辄上万个区域/数据文件，全量遍历会让界面卡住。 */
const SAVE_STAT_FILE_LIMIT = 5000;

/**
 * 实例的游戏目录，必须与 launch.ts 的 --gameDir 保持一致：
 * 版本隔离 none 时所有实例共用 <gameRoot>，saves 也就落在那边。
 */
function gameDirOf(instance: InstanceMeta): string {
  return getSettings().versionIsolation === "none" ? getPaths().gameRoot : instanceDir(instance.id);
}

const NBT_TAG_END = 0;

/**
 * level.dat 是 gzip 压缩的 NBT，这里只取 LevelName。
 * 不引依赖：要走到 LevelName 必须能跳过全部标签类型，所以写一个最小读取器；
 * 任何越界/未知标签都抛错，由调用方回退到文件夹名，绝不因此让整次列举失败。
 */
function readLevelName(data: Buffer): string | undefined {
  let pos = 0;
  let found: string | undefined;

  const need = (count: number): void => {
    if (count < 0 || pos + count > data.length) throw new Error("NBT 数据越界");
  };
  const u8 = (): number => {
    need(1);
    return data[pos++];
  };
  const i32 = (): number => {
    need(4);
    const value = data.readInt32BE(pos);
    pos += 4;
    return value;
  };
  const str = (): string => {
    need(2);
    const length = data.readUInt16BE(pos);
    pos += 2;
    need(length);
    const text = data.toString("utf8", pos, pos + length);
    pos += length;
    return text;
  };
  const skip = (count: number): void => {
    need(count);
    pos += count;
  };

  const payload = (tag: number, name: string): void => {
    switch (tag) {
      // byte / short / int / long / float / double：定长跳过
      case 1: skip(1); return;
      case 2: skip(2); return;
      case 3: skip(4); return;
      case 4: skip(8); return;
      case 5: skip(4); return;
      case 6: skip(8); return;
      case 7: {
        // byte_array
        skip(i32());
        return;
      }
      case 8: {
        const text = str();
        if (name === "LevelName" && found === undefined) found = text;
        return;
      }
      case 9: {
        // list：元素类型只出现一次
        const elementTag = u8();
        const length = i32();
        if (length < 0 || length > data.length) throw new Error("NBT 列表长度异常");
        for (let index = 0; index < length && elementTag !== NBT_TAG_END; index += 1) payload(elementTag, "");
        return;
      }
      case 10: {
        for (;;) {
          const childTag = u8();
          if (childTag === NBT_TAG_END) return;
          payload(childTag, str());
        }
      }
      case 11: {
        skip(i32() * 4);
        return;
      }
      case 12: {
        skip(i32() * 8);
        return;
      }
      default:
        throw new Error("未知的 NBT 标签类型 " + String(tag));
    }
  };

  if (u8() !== 10) return undefined;
  str(); // 根标签名（原版写的是空串）
  payload(10, "");
  return found;
}

async function readLevelNameFromFile(file: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(file);
    // 极少数工具写出的是未压缩 NBT：按 gzip 魔数判断，别硬解压
    const data = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const name = readLevelName(data)?.trim();
    return name && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/** 目录内文件总大小；数到 SAVE_STAT_FILE_LIMIT 个文件就停，返回已统计的值。 */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let files = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && files < SAVE_STAT_FILE_LIMIT) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= SAVE_STAT_FILE_LIMIT) break;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      // 符号链接等特殊文件不计：它们的 size 不是真实占用
      if (!entry.isFile()) continue;
      try {
        total += (await fs.stat(full)).size;
        files += 1;
      } catch {
        // 统计途中被删：跳过
      }
    }
  }
  return total;
}

/** 渲染进程要直接用这个 URL 加载存档图标，所以路径必须先转成正斜杠再 encodeURI。 */
function toFileUrl(path: string): string {
  return "file:///" + encodeURI(path.replace(/\\/g, "/").replace(/^\/+/, ""));
}

/**
 * 列出实例的单人存档（<gameDir>/saves）。
 * 只认含 level.dat 的目录：空目录、损坏存档、只剩 session.lock 的目录都不算存档。
 */
export async function listSaves(instanceId: string): Promise<SaveInfo[]> {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error(`实例不存在：${instanceId}`);
  const savesDir = join(gameDirOf(instance), "saves");

  let entries: Dirent[];
  try {
    entries = await fs.readdir(savesDir, { withFileTypes: true });
  } catch {
    // 还没进过游戏：saves 目录不存在，不算错误
    return [];
  }

  const saves: SaveInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = join(savesDir, entry.name);
    const levelFile = join(folderPath, "level.dat");
    let levelStat;
    try {
      levelStat = await fs.stat(levelFile);
    } catch {
      log.warn(`存档目录缺少 level.dat，已跳过：${folderPath}`);
      continue;
    }
    if (!levelStat.isFile()) continue;

    const save: SaveInfo = {
      folder: entry.name,
      name: (await readLevelNameFromFile(levelFile)) ?? entry.name,
      sizeBytes: await directorySize(folderPath),
      // 用 level.dat 的 mtime：目录 mtime 只反映增删文件，存档内保存不会更新它
      lastModified: levelStat.mtimeMs,
    };
    const iconPath = join(folderPath, "icon.png");
    if (existsSync(iconPath)) save.iconUrl = toFileUrl(iconPath);
    saves.push(save);
  }

  saves.sort((a, b) => b.lastModified - a.lastModified);
  return saves;
}
