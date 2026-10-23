import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import { IPC } from "../../shared/ipc";
import type { ServerConsoleLine, ServerEntry, ServerMeta, ServerStatus } from "../../shared/types";
import { logger } from "../core/logger";
import { findJavaHome, resolveRequiredMajor } from "../java/locate";
import { readMeta, serverDir, writeMeta } from "./store";
import { mt } from "../core/i18n";

const log = logger("servers/process");

/** 每个服务端最多留 2000 行控制台（环形缓冲）。 */
const MAX_LINES = 2000;
const STOP_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 3_000;
const MIN_MEMORY_MB = 512;

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
}

/** 自检注入点：替换 java 可执行文件，或整条命令行。 */
export interface ProcessOverrides {
  javaExe?: string;
  spawn?: (plan: SpawnPlan) => SpawnPlan;
}

let overrides: ProcessOverrides = {};

export function configureProcess(next: ProcessOverrides | null): void {
  overrides = next ?? {};
}

export interface PushSink {
  consoleLine(line: ServerConsoleLine): void;
  status(entries: ServerEntry[]): void;
}

function windows(): BrowserWindow[] {
  try {
    const list = BrowserWindow?.getAllWindows?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const electronSink: PushSink = {
  consoleLine: (line) => {
    for (const win of windows()) {
      try { win.webContents.send(IPC.serversConsoleLine, line); } catch { /* 窗口正在销毁 */ }
    }
  },
  status: (entries) => {
    for (const win of windows()) {
      try { win.webContents.send(IPC.serversStatus, entries); } catch { /* 窗口正在销毁 */ }
    }
  },
};

let sink: PushSink = electronSink;

/** 自检时换成内存收集器；传 null 恢复真实 IPC 推送。 */
export function setPushSink(next: PushSink | null): void {
  sink = next ?? electronSink;
}

let entriesProvider: (() => Promise<ServerEntry[]>) | null = null;

/** 状态推送要带上完整列表，由 index 提供（避免 process ↔ index 循环依赖）。 */
export function setEntriesProvider(fn: (() => Promise<ServerEntry[]>) | null): void {
  entriesProvider = fn;
}

let pushQueue: Promise<void> = Promise.resolve();

/**
 * 状态推送串行排队，并把"这次变化的状态"钉在快照上：
 * 列表读盘是异步的，不钉的话一次 starting → running 会被合并成两个 running，
 * 界面就再也看不到启动中的中间态。
 */
function emitStatus(snapshot: { id: string; status: ServerStatus } | null): void {
  const provider = entriesProvider;
  if (!provider) return;
  pushQueue = pushQueue.then(async () => {
    try {
      const entries = await provider();
      sink.status(
        snapshot
          ? entries.map((entry) => (entry.meta.id === snapshot.id ? { ...entry, status: snapshot.status } : entry))
          : entries,
      );
    } catch (err) {
      log.warn(`推送服务端状态失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

function pushStatus(): void {
  emitStatus(null);
}

interface Runtime {
  status: ServerStatus;
  child: ChildProcess | null;
  buffer: ServerConsoleLine[];
  partial: { stdout: string; stderr: string };
  stopRequested: boolean;
  waiters: Array<() => void>;
  /** 并发的两次 start 共用同一次 spawn（否则会起两个进程）。 */
  pending: Promise<ServerStatus> | null;
}

const runtimes = new Map<string, Runtime>();

function runtime(id: string): Runtime {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = {
      status: "stopped",
      child: null,
      buffer: [],
      partial: { stdout: "", stderr: "" },
      stopRequested: false,
      waiters: [],
      pending: null,
    };
    runtimes.set(id, rt);
  }
  return rt;
}

export function getStatus(id: string): ServerStatus {
  return runtimes.get(id)?.status ?? "stopped";
}

export function isRunning(id: string): boolean {
  const rt = runtimes.get(id);
  return !!rt && rt.child !== null;
}

export function hasRunning(): boolean {
  for (const rt of runtimes.values()) if (rt.child) return true;
  return false;
}

export function consoleLines(id: string, limit = 200): ServerConsoleLine[] {
  const buffer = runtimes.get(id)?.buffer ?? [];
  const count = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(MAX_LINES, Math.floor(Number(limit)))) : 200;
  return buffer.slice(Math.max(0, buffer.length - count));
}

function appendLine(id: string, stream: ServerConsoleLine["stream"], text: string): void {
  const rt = runtime(id);
  const line: ServerConsoleLine = { serverId: id, at: Date.now(), stream, text };
  rt.buffer.push(line);
  if (rt.buffer.length > MAX_LINES) rt.buffer.splice(0, rt.buffer.length - MAX_LINES);
  try { sink.consoleLine(line); } catch { /* 推送失败不该影响进程 */ }
}

function setStatus(id: string, status: ServerStatus): void {
  const rt = runtime(id);
  if (rt.status === status) return;
  rt.status = status;
  emitStatus({ id, status });
}

function pipeLines(id: string, rt: Runtime, stream: "stdout" | "stderr", chunk: Buffer): void {
  const text = rt.partial[stream] + chunk.toString("utf8");
  const parts = text.split(/\r?\n/);
  rt.partial[stream] = parts.pop() ?? "";
  for (const line of parts) appendLine(id, stream, line);
}

function flushPartial(id: string, rt: Runtime): void {
  for (const stream of ["stdout", "stderr"] as const) {
    const rest = rt.partial[stream];
    rt.partial[stream] = "";
    if (rest.trim()) appendLine(id, stream, rest);
  }
}

/** 服务端 jar 用控制台版 java.exe（javaw 会把输出吞掉）。 */
async function resolveJavaExe(mcVersion: string): Promise<string> {
  if (overrides.javaExe) return overrides.javaExe;
  const major = await resolveRequiredMajor(mcVersion);
  const home = await findJavaHome(major);
  if (!home) {
    throw new Error(mt("srv.javaRequired", { major }));
  }
  const exe = join(home, "bin", "java.exe");
  if (!existsSync(exe)) throw new Error(mt("srv.javaIncomplete", { path: exe, major }));
  return exe;
}

/** 真实 java 命令行；自检注入的 spawn 覆盖只作用在真正 spawn 的那一份上。 */
async function basePlan(meta: ServerMeta): Promise<SpawnPlan> {
  const javaExe = await resolveJavaExe(meta.mcVersion);
  const memory = Math.max(MIN_MEMORY_MB, Math.round(meta.memoryMb));
  const initial = Math.max(256, Math.floor(memory / 2));
  return {
    command: javaExe,
    args: [`-Xmx${memory}M`, `-Xms${initial}M`, "-jar", meta.jarFile, "nogui"],
    cwd: serverDir(meta.id),
  };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch { /* 已退出 */ }
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => undefined);
      return;
    } catch (err) {
      log.warn(`taskkill 失败，改用 kill：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
}

function waitExit(rt: Runtime, timeoutMs: number): Promise<boolean> {
  if (!rt.child) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const index = rt.waiters.indexOf(onExit);
      if (index >= 0) rt.waiters.splice(index, 1);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    rt.waiters.push(onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function handleExit(
  id: string,
  rt: Runtime,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  flushPartial(id, rt);
  rt.child = null;
  const exitedCode = code ?? (rt.stopRequested ? 0 : -1);
  const status: ServerStatus = rt.stopRequested || code === 0 ? "stopped" : "crashed";
  rt.stopRequested = false;

  appendLine(id, "system", mt("srv.console.exited", { code: code === null ? "null" : code, signal: signal ? " · signal=" + signal : "" }));
  // 先落盘再唤醒等待者：stop() 返回时 server.json 里已经有 lastExitCode
  try {
    const meta = await readMeta(id);
    await writeMeta({ ...meta, lastExitCode: exitedCode });
  } catch (err) {
    log.warn(`记录服务端 ${id} 退出状态失败：${err instanceof Error ? err.message : String(err)}`);
  }
  setStatus(id, status);
  const waiters = rt.waiters.splice(0, rt.waiters.length);
  for (const wake of waiters) wake();
  if (status === "crashed") log.warn(`服务端 ${id} 异常退出（exitCode=${exitedCode}）`);
}

/** 幂等启动：已经在跑就直接返回当前状态，不会起第二个进程。 */
export async function startServer(id: string): Promise<ServerStatus> {
  const rt = runtime(id);
  if (rt.child) {
    log.info(`服务端 ${id} 已在运行，忽略重复启动`);
    return rt.status;
  }
  // 并发两次 start 也必须只 spawn 一次：共用同一个在飞 promise
  if (rt.pending) {
    log.info(`服务端 ${id} 正在启动中，复用本次启动`);
    return await rt.pending;
  }
  const run = doStart(id, rt);
  rt.pending = run;
  try {
    return await run;
  } finally {
    if (rt.pending === run) rt.pending = null;
  }
}

async function doStart(id: string, rt: Runtime): Promise<ServerStatus> {
  const meta = await readMeta(id);
  const base = await basePlan(meta);
  const plan = overrides.spawn ? overrides.spawn(base) : base;

  rt.stopRequested = false;
  rt.partial = { stdout: "", stderr: "" };
  setStatus(id, "starting");
  appendLine(id, "system", mt("srv.console.started", { name: meta.name, cmd: base.command, args: base.args.join(" ") }));

  let child: ChildProcess;
  try {
    child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLine(id, "system", mt("srv.console.startFailed", { error: message }));
    setStatus(id, "crashed");
    throw new Error(mt("srv.startFailed", { error: message }));
  }

  rt.child = child;
  child.stdout?.on("data", (chunk: Buffer) => pipeLines(id, rt, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => pipeLines(id, rt, "stderr", chunk));
  child.on("spawn", () => { if (rt.child === child) setStatus(id, "running"); });
  child.on("error", (err) => { appendLine(id, "system", mt("srv.console.processError", { error: err.message })); });
  child.on("exit", (code, signal) => { void handleExit(id, rt, code, signal); });

  await writeMeta({ ...meta, lastStartedAt: Date.now() }).catch((err: unknown) => {
    log.warn(`记录服务端 ${id} 启动时间失败：${err instanceof Error ? err.message : String(err)}`);
  });
  return rt.status;
}

/** 幂等停止：先发 stop，10s 不退再杀进程树。 */
export async function stopServer(id: string): Promise<ServerStatus> {
  const rt = runtime(id);
  const child = rt.child;
  if (!child) {
    if (rt.status !== "stopped") setStatus(id, "stopped");
    return rt.status;
  }

  rt.stopRequested = true;
  setStatus(id, "stopping");
  appendLine(id, "system", mt("srv.console.stopping"));
  try {
    child.stdin?.write("stop\n");
  } catch (err) {
    log.warn(`向服务端 ${id} 写入 stop 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!(await waitExit(rt, STOP_TIMEOUT_MS)) && rt.child) {
    appendLine(id, "system", mt("srv.console.forceKill", { seconds: Math.round(STOP_TIMEOUT_MS / 1000) }));
    killTree(rt.child);
    if (!(await waitExit(rt, KILL_TIMEOUT_MS))) {
      appendLine(id, "system", mt("srv.console.stillRunning"));
      rt.child = null;
      setStatus(id, "stopped");
    }
  }
  return rt.status;
}

/** 往 stdin 写一行；进程没在跑就报错（界面据此提示）。 */
export function sendCommand(id: string, line: string): void {
  const rt = runtime(id);
  const child = rt.child;
  const text = String(line ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!text) throw new Error(mt("srv.commandRequired"));
  if (!child || !child.stdin || child.stdin.destroyed) throw new Error(mt("srv.notRunning"));
  appendLine(id, "system", `> ${text}`);
  child.stdin.write(text + "\n");
}

/** 启动器退出前调用：所有在跑的服务端依次 stop → 超时 kill。 */
export async function stopAllForQuit(): Promise<void> {
  const ids = [...runtimes.entries()].filter(([, rt]) => rt.child !== null).map(([id]) => id);
  if (ids.length === 0) return;
  log.info(`退出前停止 ${ids.length} 个正在运行的服务端：${ids.join("、")}`);
  await Promise.all(
    ids.map(async (id) => {
      try {
        await stopServer(id);
      } catch (err) {
        log.warn(`停止服务端 ${id} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

let lifecycleInstalled = false;
let quittingForServers = false;

/** 退出前确认：还有 running 的服务端就先阻止退出，停干净再放行。 */
export function installLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  try {
    if (!app || typeof app.on !== "function") return;
  } catch {
    return;
  }
  // before-quit 覆盖 window-all-closed → app.quit() 的路径，也覆盖托盘/菜单退出
  app.on("before-quit", (event) => {
    if (!hasRunning()) return;
    event.preventDefault();
    if (quittingForServers) return;
    quittingForServers = true;
    log.info("启动器退出：先停止正在运行的服务端");
    void stopAllForQuit().finally(() => {
      quittingForServers = false;
      app.quit();
    });
  });
}
