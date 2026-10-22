// 模组前置依赖：解析（各来源自己出）→ 补名称（复用带缓存的项目接口）→ 判断实例里是否已装
// （安装索引 NaiWa/meta/mod-install-map.json + mods 目录扫描），最后由安装流程按顺序补齐缺失前置。
// 名称与 installed 都只是「尽力而为」：任何一次查询失败都不阻塞安装，宁可让界面少显示一个名字。
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { InstanceMeta, ModContentKind, ModDependency, ModProviderId } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { downloadModFile } from "./install";
import { modsDirForInstance, readModMetadata } from "./installed";
import {
  bestFile, mapLimit, matchTier, messageOf, type MatchTier, type ModProvider, type RawDependency,
} from "./provider";

const log = logger("mods");

/** 补名称时的并发：来源 API 有速率限制，依赖数量通常个位数。 */
const NAME_CONCURRENCY = 4;

/** 依赖数量与 jar 数量都不大，但都要设闸门避免极端数据打爆请求/磁盘。 */
const MAX_DEPENDENCIES = 32;

/** 安装索引里的一条记录：谁装的、属于哪个项目、哪个版本、哪类内容。 */
export interface ModInstallRecord {
  provider: ModProviderId;
  projectId: string;
  versionId?: string;
  /** 内容类型（模组/光影/资源包/整合包）：同一索引要能分清落到哪个目录。旧记录按 "mod" 处理。 */
  kind: ModContentKind;
}

/** NaiWa/meta/mod-install-map.json 的结构：instanceId → fileName → 记录。 */
export type ModInstallMap = Record<string, Record<string, ModInstallRecord>>;

const MAP_FILE = "mod-install-map.json";

function mapFile(): string {
  return join(getPaths().meta, MAP_FILE);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function providerOf(value: unknown): ModProviderId | null {
  return value === "modrinth" || value === "curseforge" ? value : null;
}

const CONTENT_KINDS = ["mod", "shader", "resourcepack", "modpack", "map"] as const;

/** 旧索引没有 kind 字段：一律当模组，读不出合法值时也不让整份索引崩掉。 */
function kindOf(value: unknown): ModContentKind {
  return typeof value === "string" && (CONTENT_KINDS as readonly string[]).includes(value)
    ? (value as ModContentKind)
    : "mod";
}

/**
 * 读取安装索引。文件不存在、损坏、字段不合法都退化成「空索引」：
 * 索引只是加速与判重的辅助，坏了也不能让依赖检查或安装失败。
 */
export async function readInstallMap(): Promise<ModInstallMap> {
  const text = await readFile(mapFile(), "utf8").catch(() => "");
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    log.warn(`安装索引损坏，按空索引处理：${mapFile()}`);
    return {};
  }

  const map: ModInstallMap = {};
  for (const [instanceId, files] of Object.entries(asObject(raw))) {
    const byFile: Record<string, ModInstallRecord> = {};
    for (const [fileName, entry] of Object.entries(asObject(files))) {
      const record = asObject(entry);
      const provider = providerOf(record.provider);
      const projectId = typeof record.projectId === "string" ? record.projectId : "";
      if (!provider || !projectId) continue;
      const versionId = typeof record.versionId === "string" && record.versionId ? record.versionId : undefined;
      byFile[fileName] = { provider, projectId, versionId, kind: kindOf(record.kind) };
    }
    if (Object.keys(byFile).length > 0) map[instanceId] = byFile;
  }
  return map;
}

/** 先写临时文件再 rename：崩溃时不会留下半截 json（与 settings 的写法一致）。 */
async function writeMap(map: ModInstallMap): Promise<void> {
  const file = mapFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2) + "\n", "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** 写入串行化：并发安装时两次「读-改-写」会互相覆盖，串起来才可靠。 */
let writeQueue: Promise<unknown> = Promise.resolve();

/** 记一条安装记录（每次 install 成功后调用）：整份索引原子写，失败不冒泡到安装结果。 */
export async function rememberInstalled(
  instanceId: string,
  fileName: string,
  record: ModInstallRecord,
): Promise<void> {
  const run = writeQueue.then(async () => {
    const map = await readInstallMap();
    map[instanceId] = { ...(map[instanceId] ?? {}), [fileName]: record };
    await writeMap(map);
  });
  writeQueue = run.catch(() => undefined);
  try {
    await run;
  } catch (err) {
    // 索引只是判重加速：写失败时依赖检查会退回扫描 mods 目录，不必让安装失败
    log.warn(`安装索引写入失败（不影响本次安装）：${fileName} · ${messageOf(err)}`);
  }
}

/** slug 判定口径：小写 + 去掉所有非字母数字（"Fabric API" / "fabric_api" / "fabric-api" 同义）。 */
export function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 实例 mods 目录里的 jar 文件名（.bak 是备份，不算已装）。 */
async function listJars(instanceId: string): Promise<string[]> {
  try {
    const entries = await readdir(modsDirForInstance({ id: instanceId }), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 按索引判重：记录里的 projectId 与依赖一致，且该 jar 还在磁盘上。
 * 目录里已经没有的文件说明用户手动删过，不能算已装。
 */
function indexedMatches(instanceId: string, records: Record<string, ModInstallRecord>, jars: Set<string>) {
  const byProject = new Map<string, string>();
  for (const [fileName, record] of Object.entries(records)) {
    if (!jars.has(fileName)) continue;
    const key = normalizeSlug(record.projectId);
    if (key && !byProject.has(key)) byProject.set(key, fileName);
  }
  return (candidates: string[]): string | undefined => {
    for (const candidate of candidates) {
      const hit = byProject.get(normalizeSlug(candidate));
      if (hit) return hit;
    }
    return undefined;
  };
}

/**
 * 扫描兜底：jar 里读出来的 modId / 显示名与依赖 slug 规范化后相等即算已装。
 * 元数据按需读取并缓存，一个文件只解压一次。
 */
function slugScanner(instanceId: string, jars: string[]) {
  const tokens = new Map<string, string[]>();
  const dir = modsDirForInstance({ id: instanceId });
  return async (candidates: string[]): Promise<string | undefined> => {
    const targets = candidates.map(normalizeSlug).filter((token) => token.length > 0);
    if (targets.length === 0) return undefined;
    for (const fileName of jars) {
      let known = tokens.get(fileName);
      if (!known) {
        const meta = await readModMetadata(join(dir, fileName));
        known = [meta.modId, meta.name, basename(fileName, extname(fileName))]
          .map((value) => normalizeSlug(value ?? ""))
          .filter((token) => token.length > 0);
        tokens.set(fileName, known);
      }
      if (known.some((token) => targets.includes(token))) return fileName;
    }
    return undefined;
  };
}

/** 没有指定 fileId 时按五档匹配选最优文件，再去查它声明的依赖。 */
async function targetFileId(
  provider: ModProvider,
  projectId: string,
  instance: InstanceMeta,
  fileId?: string,
): Promise<string | undefined> {
  if (fileId) return fileId;
  const files = await provider.listFiles({
    provider: provider.id,
    projectId,
    gameVersion: instance.mcVersion,
    loader: instance.loader,
  });
  return bestFile(files, instance.mcVersion, instance.loader)?.fileId;
}

/**
 * 某个模组（或其中一个文件）的必需前置，附带名称与「本实例是否已装」。
 * 只返回 required=true 的项：来源侧的 optional/incompatible 一律不装。
 */
export async function getModDependencies(
  provider: ModProvider,
  projectId: string,
  instance: InstanceMeta,
  fileId?: string,
): Promise<ModDependency[]> {
  if (!provider.getDependencies) return [];
  const target = await targetFileId(provider, projectId, instance, fileId);
  // 找不到可用文件等于不知道要装哪一版，也就没有依赖可查
  if (!target) return [];

  const raw = (await provider.getDependencies(projectId, target)).slice(0, MAX_DEPENDENCIES);
  if (raw.length === 0) return [];

  const jars = await listJars(instance.id);
  const rows = await readInstallMap();
  const indexed = indexedMatches(instance.id, rows[instance.id] ?? {}, new Set(jars));
  const scanSlug = slugScanner(instance.id, jars);

  return mapLimit(raw, NAME_CONCURRENCY, async (dep: RawDependency) => {
    // 复用带缓存的项目接口：同一项目一次运行只查一次，拿不到名字就留空
    const project = provider.getProject
      ? await provider.getProject(dep.projectId).catch(() => undefined)
      : undefined;
    const slug = project?.slug ?? "";
    const candidates = [dep.projectId, slug].filter((value) => value.length > 0);
    let installedFileName = indexed(candidates);
    // 索引只记本启动器装的：手动放进 mods 的前置靠扫描 jar 元数据认出来
    if (!installedFileName) installedFileName = await scanSlug(candidates);

    const row: ModDependency = {
      provider: provider.id,
      projectId: dep.projectId,
      versionId: dep.versionId,
      name: project?.title,
      slug: slug || undefined,
      required: true,
      installed: installedFileName !== undefined,
      installedFileName,
    };
    return row;
  });
}

/** 依赖作者指定的版本只在「加载器也匹配」时才采信：档位 3/4 意味着换个加载器，宁可回退最优文件。 */
const PIN_MAX_TIER: MatchTier = 2;

/** 前置要装哪个文件：优先依赖指定的版本，其次按五档匹配挑最优。 */
async function dependencyFileId(provider: ModProvider, dep: ModDependency, instance: InstanceMeta): Promise<string> {
  if (dep.versionId) {
    try {
      const pinned = await provider.getFile(dep.projectId, dep.versionId);
      if (matchTier(pinned.info, instance.mcVersion, instance.loader) <= PIN_MAX_TIER) return pinned.info.fileId;
      log.warn(
        `前置 ${dep.name ?? dep.projectId} 指定的版本 ${dep.versionId} 不匹配 ${instance.mcVersion} / ${instance.loader}，改按最优文件安装`,
      );
    } catch (err) {
      log.warn(`前置 ${dep.name ?? dep.projectId} 指定版本取不到，改按最优文件安装：${messageOf(err)}`);
    }
  }

  const files = await provider.listFiles({
    provider: provider.id,
    projectId: dep.projectId,
    gameVersion: instance.mcVersion,
    loader: instance.loader,
  });
  const best = bestFile(files, instance.mcVersion, instance.loader);
  if (!best) {
    throw new Error(`项目 ${dep.projectId} 没有适用于 ${instance.mcVersion} / ${instance.loader} 的文件`);
  }
  return best.fileId;
}

/** 装一个前置：选文件 → 下载（复用同名同哈希）→ 写索引。 */
export async function installDependency(
  provider: ModProvider,
  instance: InstanceMeta,
  dep: ModDependency,
  signal?: AbortSignal,
): Promise<{ fileName: string; path: string }> {
  const fileId = await dependencyFileId(provider, dep, instance);
  const resolved = await provider.getFile(dep.projectId, fileId);
  // 名称与 slug 已经查过了，顺手当模板上下文，省掉一次项目请求
  const context = dep.name || dep.slug ? { name: dep.name, slug: dep.slug } : undefined;
  const result = await downloadModFile(instance, resolved, context, "mod", signal);
  await rememberInstalled(instance.id, result.fileName, {
    provider: provider.id,
    projectId: resolved.projectId ?? dep.projectId,
    versionId: resolved.info.fileId,
    kind: "mod",
  });
  return result;
}
