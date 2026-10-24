// 服务端内容（「开服」里装进服务端的文件）：mod → <serverDir>/mods，plugin → <serverDir>/plugins。
// 两类内容的落盘流程完全一致（同 sha1 复用、重名加 (1)、下载进度进「管理」页），
// 差别只有目标目录与「核心是否支持」，所以只实现一份；plugins.ts 只保留旧导出做兼容。
//
// 落盘约定：文件只会写进 <serversRoot>/<serverId>/(mods|plugins)，渲染层拿不到任何路径。
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { InstalledModInfo, LoaderKind, ModProviderId, ServerCoreId, ServerMeta } from "../../shared/types";
import type {
  ServerCapabilities, ServerContentInstallRequest, ServerContentInstallResult, ServerContentKind,
} from "../../shared/ipc";
import { createTask } from "../core/events";
import { downloadFile } from "../core/http";
import { mt } from "../core/i18n";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { curseforgeProvider } from "../mods/curseforge";
import { getModDetail } from "../mods/detail";
import { safeFileName } from "../mods/install";
import { sha1OfFile } from "../mods/installed";
import { modrinthProvider } from "../mods/modrinth";
import { bestFile, canonicalLoader, messageOf, type ModProvider, type ResolvedFile } from "../mods/provider";
import { isValidServerId, readMeta, serverDir } from "./store";

const log = logger("servers/content");

/** 内容类型 → 服务端里的子目录；服务端只读自己核心认的那一个。 */
const CONTENT_SUBDIRS: Record<ServerContentKind, string> = { mod: "mods", plugin: "plugins" };

const JAR_SUFFIX = ".jar";
const JAR_PATTERN = /\.jar$/i;
/** 重名最多加到这个序号：正常使用碰不到，兜住「目录里堆了 200 个同名文件」的极端情况。 */
const MAX_DUPLICATES = 200;

/** 内容提供方 → 真正解析文件与下载的来源；麦块只负责搜索，文件走 Modrinth。 */
const CONTENT_PROVIDERS: Record<ModProviderId, ModProvider> = {
  modrinth: modrinthProvider,
  minekuai: modrinthProvider,
  curseforge: curseforgeProvider,
};

/**
 * 核心 → 能装什么。键取自 shared/types.ts 的 ServerCoreId，写全才能编译通过（不臆造核心名）。
 * - Paper/Purpur/Folia：Bukkit 系插件核心，只加载 plugins
 * - Fabric/Forge/NeoForge：模组核心，只加载 mods（它们不认 Bukkit 插件）
 * - Arclight：Forge + Bukkit 的混合核心，mods 与 plugins 都加载
 * - Vanilla：原版既不加载 mods 也不加载 plugins
 */
const CORE_SUPPORT: Record<ServerCoreId, { modded: boolean; plugins: boolean }> = {
  Vanilla: { modded: false, plugins: false },
  Paper: { modded: false, plugins: true },
  Purpur: { modded: false, plugins: true },
  Folia: { modded: false, plugins: true },
  Fabric: { modded: true, plugins: false },
  Forge: { modded: true, plugins: false },
  NeoForge: { modded: true, plugins: false },
  Arclight: { modded: true, plugins: true },
};

function supportOf(core: ServerCoreId): { modded: boolean; plugins: boolean } {
  return CORE_SUPPORT[core] ?? { modded: false, plugins: false };
}

/**
 * 模组核心 → 它实际加载的加载器名：挑文件时必须按它筛，
 * 否则给 Fabric 服务端挑到 Forge 的 jar（下载得下来，但服务端根本不加载）。
 * Arclight 是 Forge 核心，按 forge 取。插件与核心无关，用不到这张表。
 */
/** 插件服核心能加载的平台；不在表里的核心（模组服/原版）本来就不允许装插件。 */
const PLUGIN_PLATFORMS: Partial<Record<ServerCoreId, string[]>> = {
  Paper: ["paper", "spigot", "bukkit"],
  Purpur: ["purpur", "paper", "spigot", "bukkit"],
  Folia: ["folia", "paper", "spigot", "bukkit"],
  Arclight: ["bukkit", "spigot", "paper"],
};

const CORE_LOADERS: Partial<Record<ServerCoreId, LoaderKind>> = {
  Fabric: "fabric",
  Forge: "forge",
  NeoForge: "neoforge",
  Arclight: "forge",
};

/** 内容类型统一在这里收口：非法值直接拒绝，别让它拼进目录名。 */
function contentKind(value: unknown): ServerContentKind {
  if (value === "mod" || value === "plugin") return value;
  throw new Error(mt("srv.content.badKind", { kind: String(value) }));
}

/** 提供方名称只用于文案（kindName/提示），取三语文案里的标签。 */
function kindLabel(kind: ServerContentKind): string {
  return mt(kind === "mod" ? "srv.content.kind.mod" : "srv.content.kind.plugin");
}

/** 服务端不存在时给一句能看懂的话（readMeta 自己的文案是「配置读不出来」）。 */
async function requireServer(serverId: string): Promise<ServerMeta> {
  if (!isValidServerId(serverId)) throw new Error(mt("srv.badId", { id: String(serverId) }));
  try {
    return await readMeta(serverId);
  } catch {
    throw new Error(mt("srv.content.serverMissing", { id: serverId }));
  }
}

/**
 * 服务端的某一类内容目录（<serverDir>/mods 或 <serverDir>/plugins），不存在时创建。
 * 目录名只由 kind 决定，不接收调用方传路径。
 */
export async function serverContentDir(serverId: string, kind: ServerContentKind): Promise<string> {
  const sub = CONTENT_SUBDIRS[contentKind(kind)];
  const dir = join(serverDir(serverId), sub);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 这个服务端的核心支持哪类内容。渲染层用它决定「装模组」还是「装插件」按钮是否可用；
 * 两者都不支持（原版）时额外给一句可读原因。
 */
export async function serverSupports(serverId: string): Promise<ServerCapabilities> {
  const meta = await requireServer(serverId);
  const support = supportOf(meta.core);
  const caps: ServerCapabilities = { core: meta.core, modded: support.modded, plugins: support.plugins };
  if (!support.modded && !support.plugins) {
    caps.reason = mt("srv.content.vanillaNoContent", { core: meta.core });
  }
  return caps;
}

/** 装之前先按核心过滤：核心不认的目录装了也白装，宁可当面拒绝。 */
function assertCoreSupports(meta: ServerMeta, kind: ServerContentKind): void {
  const support = supportOf(meta.core);
  if (kind === "mod" ? support.modded : support.plugins) return;
  if (!support.modded && !support.plugins) {
    throw new Error(mt("srv.content.vanillaNoContent", { core: meta.core }));
  }
  throw new Error(mt(
    kind === "mod" ? "srv.content.noMods" : "srv.content.noPlugins",
    { core: meta.core },
  ));
}

/**
 * 已装内容：对应目录下的 *.jar 列表（按文件名排序）；目录不存在就是空列表。
 * 每条带 sha1：界面用它判断「这个文件已经装过了」，安装时也用它做同名复用。
 */
export async function listServerContent(
  serverId: string,
  kind: ServerContentKind,
): Promise<InstalledModInfo[]> {
  const sub = CONTENT_SUBDIRS[contentKind(kind)];
  const dir = join(serverDir(serverId), sub);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: InstalledModInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !JAR_PATTERN.test(entry.name)) continue;
    const file = join(dir, entry.name);
    const info = await stat(file).catch(() => undefined);
    if (!info) continue;
    out.push({
      fileName: entry.name,
      sizeBytes: info.size,
      sha1: await sha1OfFile(file).catch(() => ""),
      name: entry.name.replace(JAR_PATTERN, ""),
    });
  }
  out.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return out;
}

/**
 * 落盘文件名：远端名先掐掉路径成分（防写穿内容目录），再保证是 .jar ——
 * 远端没给后缀就补上，给了别的后缀（.zip/.mrpack）直接拒绝，别装出一个服务端读不到的文件。
 */
function contentFileName(remoteFileName: string): string {
  const name = safeFileName(remoteFileName);
  if (JAR_PATTERN.test(name)) return name;
  if (!extname(name)) return `${name}${JAR_SUFFIX}`;
  throw new Error(mt("srv.content.notJar", { file: name }));
}

/** 目标文件的落点与「是否需要真下载」。 */
interface Target {
  fileName: string;
  path: string;
  /** 目录里已有内容完全相同的文件：这次安装没有别的事可做。 */
  reuse: boolean;
}

/**
 * 重名处理（Windows 资源管理器的习惯）：foo.jar 已存在就装成 foo (1).jar、foo (2).jar…，
 * 绝不覆盖用户已经在用的文件。同名且 sha1 一致时视为「已经装过」直接复用。
 */
async function resolveTarget(dir: string, fileName: string, sha1?: string): Promise<Target> {
  const base = fileName.slice(0, fileName.length - JAR_SUFFIX.length);
  for (let index = 0; index <= MAX_DUPLICATES; index += 1) {
    const candidate = index === 0 ? fileName : `${base} (${index})${JAR_SUFFIX}`;
    const path = join(dir, candidate);
    const info = await stat(path).catch(() => undefined);
    if (!info) return { fileName: candidate, path, reuse: false };
    if (sha1 && (await sha1OfFile(path).catch(() => "")) === sha1.toLowerCase()) {
      return { fileName: candidate, path, reuse: true };
    }
  }
  throw new Error(mt("srv.content.tooManyDuplicates", { dir: basename(dir), file: fileName }));
}

/**
 * 没给 fileId 时按服务端的游戏版本挑一个最优文件：
 * 插件只认服务端平台（见 modrinth.ts 的 PLUGIN_LOADERS），模组还要按核心的加载器筛。
 */
async function pickFileId(
  provider: ModProvider,
  req: ServerContentInstallRequest,
  meta: ServerMeta,
): Promise<string> {
  const loader = req.kind === "mod" ? CORE_LOADERS[meta.core] : undefined;
  // 插件不按 LoaderKind 走，但同样要按核心的平台筛：否则 Paper 服会挑到 velocity / bungeecord 的 jar
  const platforms = req.kind === "plugin" ? PLUGIN_PLATFORMS[meta.core] : undefined;
  const files = await provider.listFiles({
    provider: req.provider,
    projectId: req.projectId,
    kind: req.kind === "plugin" ? "plugin" : "mod",
    gameVersion: meta.mcVersion,
    loader,
  });
  const pool = loader
    ? files.filter((file) => file.loaders.some((name) => canonicalLoader(name) === loader))
    : platforms
      ? files.filter((file) => file.loaders.some((name) => platforms.includes(name.toLowerCase())))
      : files;
  const best = bestFile(pool, meta.mcVersion, loader);
  if (!best) {
    throw new Error(mt("srv.content.noFile", {
      kind: kindLabel(req.kind), project: req.projectId, version: meta.mcVersion,
    }));
  }
  return best.fileId;
}

/**
 * 模组是否明确标了「只支持客户端」：Modrinth 的 server_side=unsupported 就是这种。
 * 查不到（网络故障 / CurseForge 没这信息）一律放行 —— 不能因为查不到就拒绝安装。
 */
async function assertModRunsOnServer(kind: ServerContentKind, provider: ModProviderId, projectId: string): Promise<void> {
  if (kind !== "mod") return;
  const detail = await getModDetail(provider, projectId).catch((err: unknown) => {
    log.warn(`读取 ${projectId} 的服务端支持情况失败（跳过检查）：${messageOf(err)}`);
    return undefined;
  });
  if (detail?.serverSide === "unsupported") {
    throw new Error(mt("srv.content.clientOnly", { project: detail.title || projectId }));
  }
}

/**
 * 把某个模组/插件装进服务端：按 provider 解析文件 → 下载到 <serverDir>/(mods|plugins) → 校验 → 落地。
 * 下载用 createTask("mod")，进度帧由 downloads/index.ts 记成「管理」页的一条记录。
 */
export async function installServerContent(
  req: ServerContentInstallRequest,
  signal?: AbortSignal,
): Promise<ServerContentInstallResult> {
  const kind = contentKind(req?.kind);
  const serverId = String(req?.serverId ?? "");
  const meta = await requireServer(serverId);
  assertCoreSupports(meta, kind);

  const projectId = String(req?.projectId ?? "").trim();
  if (!projectId) throw new Error(mt("srv.content.projectMissing", { kind: kindLabel(kind) }));

  const provider = CONTENT_PROVIDERS[req.provider];
  if (!provider) throw new Error(mt("srv.content.unknownProvider", { provider: String(req.provider) }));

  await assertModRunsOnServer(kind, req.provider, projectId);

  const fileId = String(req?.fileId ?? "").trim() || (await pickFileId(provider, { ...req, projectId }, meta));
  const resolved: ResolvedFile = await provider.getFile(projectId, fileId);
  if (!resolved.info.downloadUrl) throw new Error(mt("srv.content.noUrl", { file: fileId }));
  const fileName = contentFileName(resolved.info.fileName);

  const dir = await serverContentDir(serverId, kind);
  const target = await resolveTarget(dir, fileName, resolved.sha1);
  const sizeOf = async (): Promise<number> => (await stat(target.path)).size;

  if (target.reuse) {
    const sizeBytes = await sizeOf();
    log.info(`${kindLabel(kind)} ${target.fileName} 已存在于 ${dir} 且 sha1 一致，直接复用`);
    return { fileName: target.fileName, sizeBytes, path: target.path };
  }

  const task = createTask("mod", mt("srv.content.installTitle", { kind: kindLabel(kind), file: target.fileName }));
  try {
    await downloadFile(resolved.info.downloadUrl, target.path, {
      task,
      expectedSha1: resolved.sha1,
      connections: getSettings().connectionsPerFile,
      label: target.fileName,
      signal,
    });

    const sizeBytes = await sizeOf();
    if (sizeBytes <= 0) throw new Error(mt("srv.content.emptyDownload", { file: target.fileName }));
    if (resolved.sha1) {
      const actual = await sha1OfFile(target.path);
      if (actual.toLowerCase() !== resolved.sha1.toLowerCase()) {
        await unlink(target.path).catch(() => undefined);
        throw new Error(mt("srv.content.checksumFailed", {
          file: target.fileName, expected: resolved.sha1, actual,
        }));
      }
    } else {
      log.info(`${kindLabel(kind)} ${target.fileName} 未做哈希校验（来源无哈希），已按大小 ${sizeBytes} 字节确认`);
    }

    task.done({ fileName: target.fileName, path: target.path });
    log.info(`已安装${kindLabel(kind)} ${target.fileName}（${sizeBytes} 字节）→ ${target.path}`);
    return { fileName: target.fileName, sizeBytes, path: target.path };
  } catch (err) {
    task.fail(err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 卸载：删掉对应目录里的一个 .jar（只认 .jar，防止借文件名删到别的文件）。 */
export async function removeServerContent(
  serverId: string,
  kind: ServerContentKind,
  fileName: string,
): Promise<void> {
  const sub = CONTENT_SUBDIRS[contentKind(kind)];
  await requireServer(serverId);
  const name = safeFileName(String(fileName ?? ""));
  if (!JAR_PATTERN.test(name)) throw new Error(mt("srv.content.deleteWrongType", { file: name }));
  const dir = join(serverDir(serverId), sub);
  const target = join(dir, name);
  if (!(await stat(target).catch(() => undefined))) {
    throw new Error(mt("srv.content.missing", { dir: sub, file: name }));
  }
  await unlink(target);
  log.info(`已删除 ${sub} 里的 ${name}（${dir}）`);
}
