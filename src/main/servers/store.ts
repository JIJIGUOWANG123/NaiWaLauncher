import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { ServerCreateRequest } from "../../shared/ipc";
import type { ServerCoreId, ServerMeta } from "../../shared/types";
import { createTask, type TaskHandle } from "../core/events";
import { downloadFile } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { isCoreId, resolveBuild, type ResolvedBuild } from "./fastmirror";
import { defaultProperties, editableProperties, writeProperties } from "./properties";

const log = logger("servers/store");

export const META_FILE = "server.json";
export const EULA_FILE = "eula.txt";
/** id 直接用做目录名：只允许 [a-z0-9-]，杜绝 .. 与盘符穿越。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_LENGTH = 8;
const DEFAULT_PORT = 25565;
const PORT_ATTEMPTS = 20;
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_MAX_PLAYERS = 20;
const MIN_MEMORY_MB = 512;
const MAX_MEMORY_MB = 65536;
const MAX_PLAYERS_LIMIT = 10000;
const MAX_NAME_LENGTH = 64;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export type DownloadFn = (
  url: string,
  dest: string,
  opts: { expectedSha1?: string; task?: TaskHandle },
) => Promise<unknown>;

export type PortProbe = (port: number) => Promise<boolean>;

/** 测试可注入下载/构建解析/端口探测；生产路径全用默认实现。 */
export interface CreateDeps {
  download?: DownloadFn;
  resolveBuild?: (core: ServerCoreId, mcVersion: string, coreVersion: string) => Promise<ResolvedBuild>;
  portFree?: PortProbe;
  task?: TaskHandle;
  /** 假 jar 场景下跳过 SHA1 校验（只用于自检，生产不传）。 */
  skipSha1?: boolean;
}

export function serversRoot(): string {
  return join(getPaths().root, "servers");
}

export function isValidServerId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && !id.includes("..");
}

function assertId(id: unknown): string {
  if (!isValidServerId(id)) throw new Error(`服务端 id 不合法：${String(id)}`);
  return id;
}

export function serverDir(id: string): string {
  const safe = assertId(id);
  const dir = join(serversRoot(), safe);
  // 双保险：id 已经受正则约束，这里再确认落点仍在 servers/ 之下
  if (!dir.startsWith(serversRoot())) throw new Error(`服务端目录越界：${safe}`);
  return dir;
}

export function metaFile(dir: string): string {
  return join(dir, META_FILE);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 名字不做目录名（id 才是），但要能安全写进 motd：掐掉控制字符与换行。 */
export function sanitizeName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Minecraft 服务器").slice(0, MAX_NAME_LENGTH);
}

function safeJarName(filename: string, core: ServerCoreId, mcVersion: string, coreVersion: string): string {
  const base = String(filename ?? "").replace(/^.*[\\/]/, "").trim();
  // jar 名会被拼进命令行，只留安全字符；拿不到就自己拼一个
  const cleaned = base.replace(/[^A-Za-z0-9._+-]/g, "");
  if (cleaned && cleaned.toLowerCase().endsWith(".jar")) return cleaned;
  return `${core}-${mcVersion}-${coreVersion}.jar`;
}

function normalizeMeta(raw: unknown, dirId: string): ServerMeta {
  if (!raw || typeof raw !== "object") throw new Error("server.json 内容不是对象");
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : dirId;
  if (!isValidServerId(id)) throw new Error(`server.json 的 id 不合法：${String(obj.id)}`);
  const jarFile = typeof obj.jarFile === "string" ? obj.jarFile : "";
  if (!jarFile) throw new Error("server.json 缺少 jarFile");
  const mcVersion = typeof obj.mcVersion === "string" ? obj.mcVersion : "";
  if (!mcVersion) throw new Error("server.json 缺少 mcVersion");
  if (!isCoreId(obj.core)) throw new Error(`server.json 的 core 不合法：${String(obj.core)}`);
  const meta: ServerMeta = {
    id,
    name: sanitizeName(obj.name),
    core: obj.core,
    mcVersion,
    coreVersion: typeof obj.coreVersion === "string" ? obj.coreVersion : "",
    jarFile,
    port: clampInt(obj.port, 1, 65535, DEFAULT_PORT),
    memoryMb: clampInt(obj.memoryMb, MIN_MEMORY_MB, MAX_MEMORY_MB, DEFAULT_MEMORY_MB),
    maxPlayers: clampInt(obj.maxPlayers, 1, MAX_PLAYERS_LIMIT, DEFAULT_MAX_PLAYERS),
    onlineMode: obj.onlineMode !== false,
    eulaAgreed: obj.eulaAgreed === true,
    createdAt: Number.isFinite(obj.createdAt) ? Number(obj.createdAt) : Date.now(),
  };
  if (Number.isFinite(obj.lastStartedAt)) meta.lastStartedAt = Number(obj.lastStartedAt);
  if (Number.isFinite(obj.lastExitCode)) meta.lastExitCode = Number(obj.lastExitCode);
  return meta;
}

export async function readMeta(id: string): Promise<ServerMeta> {
  const dir = serverDir(id);
  let text: string;
  try {
    text = await readFile(metaFile(dir), "utf8");
  } catch {
    throw new Error(`服务端 ${id} 不存在（缺少 server.json）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`服务端 ${id} 的 server.json 损坏：${messageOf(err)}`);
  }
  return normalizeMeta(parsed, id);
}

/**
 * Windows 上 rename 覆盖目标时，若有人正在读这个文件会拿到 EPERM/EBUSY
 * （状态推送的列表读盘正好会和它撞上）：短暂退避重试几次。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  await rm(from, { force: true }).catch(() => undefined);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 原子写：tmp + rename，进程在写一半时挂掉也不会留下半截 json。 */
export async function writeMeta(meta: ServerMeta): Promise<void> {
  const dir = serverDir(meta.id);
  await mkdir(dir, { recursive: true });
  const target = metaFile(dir);
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await renameWithRetry(tmp, target);
}

/** 按 createdAt 升序；损坏的 server.json 跳过并记日志，不拖垮整个列表。 */
export async function listServers(): Promise<ServerMeta[]> {
  const root = serversRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ServerMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidServerId(entry.name)) {
      log.warn(`跳过非法目录名的服务端目录：${entry.name}`);
      continue;
    }
    try {
      out.push(await readMeta(entry.name));
    } catch (err) {
      log.warn(`服务端 ${entry.name} 无法读取，已跳过：${messageOf(err)}`);
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

async function sha1OfFile(file: string): Promise<string> {
  const hash = createHash("sha1");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function randomId(): string {
  let out = "";
  for (let index = 0; index < ID_LENGTH; index += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

function newId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = randomId();
    if (used.has(id)) continue;
    if (existsSync(join(serversRoot(), id))) continue;
    return id;
  }
  throw new Error("无法生成唯一的服务端 id（已尝试 200 次）");
}

/** 直接试绑端口：比"探测是否有人监听"更接近服务端真实处境。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickPort(requested: unknown, used: Set<number>, free: PortProbe): Promise<number> {
  if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
    const port = Number(requested);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${String(requested)}`);
    if (used.has(port)) throw new Error(`端口 ${port} 已被其它服务端占用`);
    if (!(await free(port))) throw new Error(`端口 ${port} 已被占用`);
    return port;
  }
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const port = DEFAULT_PORT + offset;
    if (used.has(port)) continue;
    if (await free(port)) return port;
  }
  throw new Error(`端口 ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_ATTEMPTS - 1} 全部被占用，请手动指定端口`);
}

/**
 * 新建服务端：建目录 → 下 jar（带 SHA1 校验）→ eula.txt → server.properties → server.json。
 * 任一步失败都会删掉半成品目录。
 */
export async function createServer(req: ServerCreateRequest, deps: CreateDeps = {}): Promise<ServerMeta> {
  const name = sanitizeName(req?.name);
  const core = req?.core;
  if (!isCoreId(core)) throw new Error(`不支持的服务端核心：${String(core)}`);
  const mcVersion = String(req?.mcVersion ?? "").trim();
  const coreVersion = String(req?.coreVersion ?? "").trim();
  if (!mcVersion) throw new Error("游戏版本不能为空");
  if (!coreVersion) throw new Error("核心构建不能为空");

  const build = await (deps.resolveBuild ?? resolveBuild)(core, mcVersion, coreVersion);
  const download = deps.download ?? ((url, dest, opts) => downloadFile(url, dest, opts));
  const existing = await listServers();
  const id = newId(existing.map((item) => item.id));
  const dir = serverDir(id);
  const jarFile = safeJarName(build.filename, core, mcVersion, coreVersion);
  const task = deps.task ?? createTask("generic", `服务端 ${name}`);

  try {
    await mkdir(dir, { recursive: true });

    const port = await pickPort(req?.port, new Set(existing.map((item) => item.port)), deps.portFree ?? isPortFree);
    const memoryMb = clampInt(req?.memoryMb, MIN_MEMORY_MB, MAX_MEMORY_MB, DEFAULT_MEMORY_MB);
    const maxPlayers = clampInt(req?.maxPlayers, 1, MAX_PLAYERS_LIMIT, DEFAULT_MAX_PLAYERS);
    const onlineMode = req?.onlineMode !== false;
    // ServerCreateRequest 里没有 eula 字段：界面同意后创建，缺省视为已同意；
    // 显式传 false 时不写 eula.txt（服务端会拒绝启动，这是用户自己的选择）。
    const eulaAgreed = (req as ServerCreateRequest & { eulaAgreed?: boolean })?.eulaAgreed !== false;

    const dest = join(dir, jarFile);
    task.update({ stage: "下载服务端", percent: null, downloadedBytes: 0, totalBytes: 0 });
    await download(build.downloadUrl, dest, { expectedSha1: build.sha1, task });
    if (!deps.skipSha1 && build.sha1) {
      const actual = await sha1OfFile(dest).catch(() => "");
      if (actual !== build.sha1.toLowerCase()) {
        throw new Error(`服务端 jar 校验失败：期望 ${build.sha1}，实际 ${actual || "（读不到文件）"}`);
      }
    }

    if (eulaAgreed) await writeFile(join(dir, EULA_FILE), "eula=true\n", "utf8");

    const meta: ServerMeta = {
      id,
      name,
      core,
      mcVersion: build.mcVersion || mcVersion,
      coreVersion: build.coreVersion || coreVersion,
      jarFile,
      port,
      memoryMb,
      maxPlayers,
      onlineMode,
      eulaAgreed,
      createdAt: Date.now(),
    };
    await writeProperties(dir, defaultProperties(meta));
    await writeMeta(meta);
    task.done();
    log.info(`已创建服务端 ${id}（${core} ${meta.mcVersion} ${meta.coreVersion}，端口 ${port}）`);
    return meta;
  } catch (err) {
    task.fail(err);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** 只允许改这几项；端口/人数/正版校验同步写回 server.properties。 */
export async function updateServer(
  id: string,
  patch: Partial<Pick<ServerMeta, "name" | "port" | "memoryMb" | "maxPlayers" | "onlineMode" | "eulaAgreed">>,
): Promise<ServerMeta> {
  const meta = await readMeta(id);
  const next: ServerMeta = { ...meta };
  let touchesProperties = false;

  if (patch.name !== undefined) {
    const name = sanitizeName(patch.name);
    if (name !== next.name) touchesProperties = true;
    next.name = name;
  }
  if (patch.port !== undefined) {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${String(patch.port)}`);
    const others = (await listServers()).filter((item) => item.id !== meta.id).map((item) => item.port);
    if (others.includes(port)) throw new Error(`端口 ${port} 已被其它服务端占用`);
    if (port !== next.port) { next.port = port; touchesProperties = true; }
  }
  if (patch.memoryMb !== undefined) next.memoryMb = clampInt(patch.memoryMb, MIN_MEMORY_MB, MAX_MEMORY_MB, next.memoryMb);
  if (patch.maxPlayers !== undefined) {
    const maxPlayers = clampInt(patch.maxPlayers, 1, MAX_PLAYERS_LIMIT, next.maxPlayers);
    if (maxPlayers !== next.maxPlayers) touchesProperties = true;
    next.maxPlayers = maxPlayers;
  }
  if (patch.onlineMode !== undefined) {
    const onlineMode = patch.onlineMode === true;
    if (onlineMode !== next.onlineMode) touchesProperties = true;
    next.onlineMode = onlineMode;
  }
  if (patch.eulaAgreed !== undefined) {
    const agreed = patch.eulaAgreed === true;
    if (agreed !== next.eulaAgreed) {
      next.eulaAgreed = agreed;
      await writeFile(join(serverDir(id), EULA_FILE), agreed ? "eula=true\n" : "eula=false\n", "utf8");
    }
  }

  if (touchesProperties) await writeProperties(serverDir(id), editableProperties(next));
  await writeMeta(next);
  return next;
}

/** 整个目录删掉（含世界/日志/jar）；调用方负责先确认它没在跑。 */
export async function removeServer(id: string): Promise<void> {
  const dir = serverDir(id);
  await rm(dir, { recursive: true, force: true });
  log.info(`已删除服务端目录：${dir}`);
}
