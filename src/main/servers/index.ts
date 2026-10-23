import type { ServerCreateRequest } from "../../shared/ipc";
import type {
  ServerBuildInfo, ServerConsoleLine, ServerCoreId, ServerCoreInfo, ServerEntry, ServerMeta,
} from "../../shared/types";
import { logger } from "../core/logger";
import { listBuilds, listCores, resolveBuild, type ResolvedBuild } from "./fastmirror";
import {
  consoleLines as readConsoleLines, getStatus, installLifecycle, isRunning, sendCommand as writeCommand,
  setEntriesProvider, startServer as startProcess, stopAllForQuit, stopServer as stopProcess,
} from "./process";
import {
  createServer as createInStore, listServers, readMeta, removeServer as removeInStore,
  updateServer as updateInStore, type CreateDeps,
} from "./store";

const log = logger("servers");

export type { ResolvedBuild } from "./fastmirror";
export { configureProcess, setPushSink } from "./process";
export { installLifecycle };
export { createServer as createServerWithDeps, serversRoot, isValidServerId, sanitizeName } from "./store";

export async function cores(): Promise<ServerCoreInfo[]> {
  return await listCores();
}

export async function builds(core: ServerCoreId, mcVersion: string): Promise<ServerBuildInfo[]> {
  return await listBuilds(core, mcVersion);
}

export async function build(core: ServerCoreId, mcVersion: string, coreVersion: string): Promise<ResolvedBuild> {
  return await resolveBuild(core, mcVersion, coreVersion);
}

/** 列表：store 里的元数据 + 主进程托管的运行状态。 */
export async function listEntries(): Promise<ServerEntry[]> {
  const metas = await listServers();
  return metas.map((meta) => ({ meta, status: getStatus(meta.id) }));
}

export async function createServer(req: ServerCreateRequest, deps: CreateDeps = {}): Promise<ServerEntry> {
  const meta = await createInStore(req, deps);
  return { meta, status: getStatus(meta.id) };
}

export async function updateServer(
  id: string,
  patch: Partial<Pick<ServerMeta, "name" | "port" | "memoryMb" | "maxPlayers" | "onlineMode" | "eulaAgreed">>,
): Promise<ServerEntry> {
  const meta = await updateInStore(id, patch);
  return { meta, status: getStatus(meta.id) };
}

/** 删服务端：正在跑的不给删（先停），避免删掉正在被 java 打开的目录。 */
export async function removeServer(id: string): Promise<void> {
  if (isRunning(id)) throw new Error("服务端正在运行，请先停止再删除");
  await removeInStore(id);
}

export async function startServer(id: string): Promise<ServerEntry> {
  await startProcess(id);
  const meta = await readMeta(id);
  return { meta, status: getStatus(id) };
}

export async function stopServer(id: string): Promise<ServerEntry> {
  await stopProcess(id);
  const meta = await readMeta(id);
  return { meta, status: getStatus(id) };
}

export async function sendCommand(id: string, line: string): Promise<void> {
  writeCommand(id, line);
}

export async function consoleLines(id: string, limit?: number): Promise<ServerConsoleLine[]> {
  return readConsoleLines(id, limit);
}

export { stopAllForQuit };

// 状态推送需要完整列表：进程侧只负责变化，列表由这里提供（避免循环依赖）
setEntriesProvider(listEntries);

log.info("开服模块已加载");
