import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ModContentKind, ModProviderId } from "../../shared/types";
import type { ModInstallRequest } from "../../shared/ipc";
import type { DownloadJob, LoaderKind, TaskKind, TaskProgress, TaskResult } from "../../shared/types";
import { cancelledMessage, isCancelledError } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { installJava } from "../java/index";
import { installLoader } from "../loaders/index";
import { installVersion } from "../minecraft/install";
import { installMod } from "../mods/index";
import { mt } from "../core/i18n";

const log = logger("downloads");

/** 落盘与广播都用同一个节流窗口，避免下载高峰期 IPC / 磁盘洪水。 */
const THROTTLE_MS = 700;
/** 记录上限：只清理最老的，防止文件无限增长。 */
const MAX_JOBS = 300;
/** 一次性「本次调用产生的任务属于哪类下载」提示的有效期。 */
const HINT_TTL_MS = 15_000;

const LOADER_KINDS: LoaderKind[] = ["vanilla", "fabric", "quilt", "forge", "neoforge", "liteloader"];
const JOB_KINDS: DownloadJob["kind"][] = ["version", "loader", "java", "content"];
const JOB_STATUSES: DownloadJob["status"][] = ["running", "paused", "interrupted", "cancelled", "done", "failed"];
const CONTENT_KINDS: ModContentKind[] = ["mod", "shader", "resourcepack", "modpack", "map"];
const PROVIDER_IDS: ModProviderId[] = ["modrinth", "curseforge", "minekuai"];

/** 进度事件可能自带 jobId（可选），没有就走 label 归并。 */
export type ProgressEvent = TaskProgress & { jobId?: string };

/** 调用方在开始一次安装前声明的任务信息，用于给新建的 job 补上 kind / resume 参数。 */
export interface JobHint {
  kind: DownloadJob["kind"];
  detail?: string;
  resume?: string;
}

/**
 * 一次安装的上下文。
 * 并发安装下「这条进度帧 / 这条新记录属于谁」不能靠全局变量判断，否则多个安装同时跑时
 * 进度会记到别人头上。每个安装都在自己的异步上下文里执行：重放归属、新建记录、取消句柄、
 * 重试参数全部从上下文取（AsyncLocalStorage 随 await 与定时器一路传递，节流补发的那一帧
 * 也留在原上下文里），所以天然不会串线。
 */
interface InstallScope {
  /** 重放中的记录 id：本次安装产生的子任务进度归到它名下，结局由 resume() 统一收尾。 */
  ownerId: string | null;
  /** 本次安装共用的取消句柄：cancel(任一记录) 只停这一条安装。 */
  controller: AbortController;
  /** 本次安装自己创建的记录：按 label 归并时只认这些，避免并到别的安装的记录上。 */
  jobIds: Set<string>;
  /** 本次安装的重试参数；下一个新建记录会采用它。 */
  hint: JobHint | null;
}

const installScope = new AsyncLocalStorage<InstallScope>();

let jobs: DownloadJob[] = [];
let loaded = false;
/** 任务 id → job id：同一个任务后续的进度帧都落到同一条记录上。 */
let taskToJob = new Map<string, string>();
let pendingHint: (JobHint & { expiresAt: number }) | null = null;
let sequence = 0;

/**
 * 每条 running 记录对应的取消句柄：cancel() 靠它真正中断传输，而不只是改状态。
 * 一次安装（含它派生出的游戏本体/依赖库/资源三条记录）共用同一个句柄，
 * 否则取消只会停掉其中一段，其余分片照样把流量跑完。
 */
const controllers = new Map<string, AbortController>();
/** 正在跑的安装数：安装级并发，上限取设置里的 concurrentDownloads（不是文件级并发）。 */
let activeInstalls = 0;
interface SlotWaiter {
  grant(): void;
}
/** 等槽位的安装，FIFO：先点的先跑。 */
const slotWaiters: SlotWaiter[] = [];
let slotPumpTimer: ReturnType<typeof setInterval> | null = null;

let writeQueue: Promise<void> = Promise.resolve();
let lastPersistAt = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

let changedSink: ((list: DownloadJob[]) => void) | null = null;
let lastBroadcastAt = 0;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function jobFile(): string {
  return join(getPaths().meta, "download-jobs.json");
}

function now(): number {
  return Date.now();
}

/** 安装级并发上限：每次现读设置里的「同时下载数」，运行中改设置立刻生效（1..32）。 */
function installLimit(): number {
  const raw = Number(getSettings().concurrentDownloads);
  if (!Number.isFinite(raw)) return 12;
  return Math.min(32, Math.max(1, Math.trunc(raw)));
}

function stopSlotPump(): void {
  if (!slotPumpTimer) return;
  clearInterval(slotPumpTimer);
  slotPumpTimer = null;
}

function pumpInstallSlots(): void {
  const limit = installLimit();
  while (activeInstalls < limit && slotWaiters.length > 0) {
    activeInstalls += 1;
    (slotWaiters.shift() as SlotWaiter).grant();
  }
  if (slotWaiters.length === 0) stopSlotPump();
}

/**
 * 排队期间定时重读设置：把「同时下载数」调大时排队的安装立刻放行，
 * 不必等到某条装完才腾出槽位。队列空了就停表。
 */
function startSlotPump(): void {
  if (slotPumpTimer) return;
  slotPumpTimer = setInterval(pumpInstallSlots, 150);
  slotPumpTimer.unref?.();
}

/**
 * 取一个安装槽位（FIFO）。满额时一直等；signal 中止则立刻从队列移除并抛「下载已取消」。
 * 返回的释放函数必须调用，否则后面的安装永远等不到槽位。
 */
export function acquireInstallSlot(signal?: AbortSignal): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(cancelledMessage()));
      return;
    }
    let released = false;
    const waiter: SlotWaiter = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(() => {
          if (released) return;
          released = true;
          activeInstalls = Math.max(0, activeInstalls - 1);
          pumpInstallSlots();
        });
      },
    };
    const onAbort = (): void => {
      const index = slotWaiters.indexOf(waiter);
      // 已经拿到槽位：交给 work 自己感知 abort（句柄是同一个）
      if (index < 0) return;
      slotWaiters.splice(index, 1);
      reject(new Error(cancelledMessage()));
    };
    slotWaiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    startSlotPump();
    pumpInstallSlots();
  });
}

/** 闸门快照（自检与日志用）：active = 正在跑的安装数，queued = 排队数，limit = 当前设置的上限。 */
export function installGateState(): { active: number; queued: number; limit: number } {
  return { active: activeInstalls, queued: slotWaiters.length, limit: installLimit() };
}

function newId(): string {
  sequence += 1;
  return `job-${now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 字节类字段的收敛：负数/NaN/非数字一律当作「没有这个数」，不要污染记录。 */
function byteCount(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.round(num);
}

function clampProgress(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(100, Math.max(0, Math.round(num)));
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 一条记录落盘前的收敛：字段类型不对就整条丢弃，保证读回来的永远是合法 DownloadJob。 */
function normalizeJob(raw: unknown): DownloadJob | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const id = typeof src.id === "string" ? src.id.trim() : "";
  const title = typeof src.title === "string" ? src.title : "";
  if (!id || !title) return null;
  const created = typeof src.createdAt === "number" && Number.isFinite(src.createdAt) ? src.createdAt : now();
  const updated = typeof src.updatedAt === "number" && Number.isFinite(src.updatedAt) ? src.updatedAt : created;
  const job: DownloadJob = {
    id,
    kind: pickEnum(src.kind, JOB_KINDS, "version"),
    title,
    detail: typeof src.detail === "string" ? src.detail : title,
    status: pickEnum(src.status, JOB_STATUSES, "interrupted"),
    progress: clampProgress(src.progress, 0),
    createdAt: created,
    updatedAt: updated,
  };
  if (typeof src.message === "string" && src.message) job.message = src.message;
  if (typeof src.resume === "string" && src.resume.trim()) job.resume = src.resume;
  // 速度与「已下载/总大小」也要读回来：重启后管理页还要显示上次的字节数
  const downloadedBytes = byteCount(src.downloadedBytes);
  const totalBytes = byteCount(src.totalBytes);
  const bytesPerSecond = byteCount(src.bytesPerSecond);
  if (downloadedBytes !== undefined) job.downloadedBytes = downloadedBytes;
  if (totalBytes !== undefined && totalBytes > 0) job.totalBytes = totalBytes;
  if (bytesPerSecond !== undefined) job.bytesPerSecond = bytesPerSecond;
  return job;
}

function snapshot(): DownloadJob[] {
  return jobs
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => ({ ...job }));
}

/** 原子写：先写临时文件再 rename，崩溃时不会留下半截 json。 */
async function writeAtomic(text: string): Promise<void> {
  const file = jobFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** 串行化写盘：所有写操作排在同一条 Promise 链上，不会互相覆盖。 */
function persistNow(): Promise<void> {
  if (!dirty) return writeQueue;
  dirty = false;
  lastPersistAt = now();
  const text = JSON.stringify({ version: 1, jobs }, null, 2) + "\n";
  const run = writeQueue.then(
    () => writeAtomic(text),
    () => writeAtomic(text),
  );
  writeQueue = run.catch(() => undefined);
  return run.catch((err: unknown) => {
    log.warn(`下载记录写入失败：${err instanceof Error ? err.message : String(err)}`);
  });
}

function schedulePersist(): void {
  dirty = true;
  const wait = THROTTLE_MS - (now() - lastPersistAt);
  if (wait <= 0) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    void persistNow();
    return;
  }
  if (!persistTimer) {
    // 尾随补发：节流窗口内最后一次变更也会落盘
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, wait);
  }
}

/** 立即落盘（用户主动操作后调用，保证关窗口也不丢状态）。 */
export async function flushPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistNow();
  await writeQueue;
}

function pushChanged(): void {
  if (!changedSink) return;
  lastBroadcastAt = now();
  try {
    changedSink(snapshot());
  } catch {
    /* 渲染进程异常不应打断任务 */
  }
}

function scheduleBroadcast(): void {
  const wait = THROTTLE_MS - (now() - lastBroadcastAt);
  if (wait <= 0) {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    pushChanged();
    return;
  }
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      pushChanged();
    }, wait);
  }
}

/** 注册推送出口（主进程转发到 downloads:changed）。 */
export function setChangedSink(next: ((list: DownloadJob[]) => void) | null): void {
  changedSink = next;
}

function touch(job: DownloadJob, patch: Partial<DownloadJob>): void {
  Object.assign(job, patch);
  job.updatedAt = now();
  schedulePersist();
  scheduleBroadcast();
}

/** 读盘；把上次被强行关闭时残留的 running 记录改判为 interrupted。 */
/** 读盘 + 修复的 promise：启动时跑到后台，读一次就够，界面问起来直接等它。 */
let loadPromise: Promise<DownloadJob[]> | null = null;

/** 记录就绪：还没开始读就先读，读过的直接复用同一次结果（改判中断只做一次）。 */
export function ready(): Promise<DownloadJob[]> {
  return loadPromise ?? load();
}

export function load(): Promise<DownloadJob[]> {
  if (!loadPromise) loadPromise = loadFromDisk();
  return loadPromise;
}

async function loadFromDisk(): Promise<DownloadJob[]> {
  loaded = true;
  let text: string | null = null;
  try {
    text = await readFile(jobFile(), "utf8");
  } catch {
    jobs = [];
    taskToJob = new Map();
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn("下载记录文件损坏，已重置");
    jobs = [];
    taskToJob = new Map();
    return [];
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : [];

  const next: DownloadJob[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const job = normalizeJob(raw);
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    next.push(job);
  }

  let repaired = 0;
  for (const job of next) {
    if (job.status !== "running") continue;
    // 上次进程里它还 running → 说明启动器被强杀，重启后一律视为中断可继续
    job.status = "interrupted";
    if (!job.message) job.message = mt("dl.messageIncomplete");
    job.updatedAt = now();
    repaired += 1;
  }
  jobs = next;
  taskToJob = new Map();
  if (repaired > 0) {
    dirty = true;
    await persistNow();
    log.info(`已将 ${repaired} 条未完成的下载记录标记为中断`);
  }
  return snapshot();
}

export function list(): DownloadJob[] {
  return snapshot();
}

/** 调用方在发起安装前声明本次任务的类型与重试参数；下一条新建记录会采用它。 */
export function hintNextJob(hint: JobHint): void {
  pendingHint = { ...hint, expiresAt: now() + HINT_TTL_MS };
}

/** 摘走全局那条一次性提示（IPC 在发起安装前声明，进入安装上下文时被摘走）。 */
function takePendingHint(): JobHint | null {
  const hint = pendingHint;
  pendingHint = null;
  if (!hint || hint.expiresAt < now()) return null;
  return hint;
}

/** 本次安装新建记录要用的重试参数：上下文里的优先（并发安装各拿各的，不会互相顶掉）。 */
function takeHint(): JobHint | null {
  const scope = installScope.getStore();
  if (!scope) return takePendingHint();
  const hint = scope.hint;
  scope.hint = null;
  return hint;
}

function kindForTask(kind: TaskKind): DownloadJob["kind"] {
  switch (kind) {
    case "loader":
      return "loader";
    case "java":
      return "java";
    case "mod":
      return "content";
    default:
      // game / libraries / assets / generic 都属于装一个游戏版本
      return "version";
  }
}

function createJob(input: { id?: string; kind: DownloadJob["kind"]; title: string; detail: string; resume?: string }): DownloadJob {
  const stamp = now();
  const job: DownloadJob = {
    id: input.id ?? newId(),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    status: "running",
    progress: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
  if (input.resume) job.resume = input.resume;
  // 记录挂到「产生它的那次安装」的句柄上：并发安装互不影响各自的取消
  const scope = installScope.getStore();
  if (scope) {
    controllers.set(job.id, scope.controller);
    scope.jobIds.add(job.id);
  }
  jobs.unshift(job);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
  return job;
}

function releaseController(controller: AbortController): void {
  for (const [jobId, mapped] of controllers) {
    if (mapped === controller) controllers.delete(jobId);
  }
}

/**
 * 前台安装（IPC 直接发起）的统一入口：给这次安装绑定自己的异步上下文与可取消句柄，
 * 再向安装闸门要一个槽位（满额则 FIFO 排队）。
 * 安装期间产生的所有下载记录都绑到同一个句柄上，所以 cancel(任一记录) 能真正停下这次传输。
 */
export async function runCancellable<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  // 重试参数在等槽位之前就摘走：留着会被排在后面的安装抢走
  const scope: InstallScope = { ownerId: null, controller, jobIds: new Set<string>(), hint: takePendingHint() };
  try {
    return await installScope.run(scope, async () => {
      const release = await acquireInstallSlot(controller.signal);
      try {
        return await work(controller.signal);
      } finally {
        release();
      }
    });
  } finally {
    releaseController(controller);
  }
}

/** 找到（或新建）一条进度事件对应的记录。 */
function acquireJob(event: ProgressEvent): DownloadJob {
  const mappedId = taskToJob.get(event.taskId);
  if (mappedId) {
    const mapped = jobs.find((job) => job.id === mappedId);
    if (mapped) return mapped;
  }

  if (event.jobId) {
    const given = jobs.find((job) => job.id === event.jobId);
    if (given) {
      taskToJob.set(event.taskId, given.id);
      return given;
    }
  }

  const scope = installScope.getStore();
  const ownerId = scope?.ownerId ?? null;
  if (ownerId) {
    const owner = jobs.find((job) => job.id === ownerId);
    if (owner) {
      taskToJob.set(event.taskId, owner.id);
      return owner;
    }
  }

  const kind = kindForTask(event.kind);
  const hintKind = scope ? scope.hint?.kind : pendingHint?.kind;
  // 事件里没有 jobId：按 label 归并到「本次安装」正在跑的同名记录，否则新建一条。
  // 归并只认本次安装自己建的记录，否则两个安装撞了同名 label 会互相改写进度。
  const merged = jobs.find((job) =>
    job.title === event.label && job.status === "running" && (job.kind === kind || job.kind === hintKind)
    && (scope === undefined || scope.jobIds.has(job.id)),
  );
  if (merged) {
    taskToJob.set(event.taskId, merged.id);
    return merged;
  }

  const hint = takeHint();
  const job = createJob({
    id: event.jobId,
    kind: hint?.kind ?? kind,
    title: event.label,
    detail: hint?.detail ?? event.label,
    resume: hint?.resume,
  });
  taskToJob.set(event.taskId, job.id);
  return job;
}

/** 进度事件落库（IPC task:progress 的同一份数据）。 */
export function trackProgress(event: ProgressEvent): void {
  if (!event || typeof event.taskId !== "string" || !event.taskId) return;
  const job = acquireJob(event);
  const resumeOwned = job.id === installScope.getStore()?.ownerId;
  // 已完成/已取消的记录不再被后续进度帧改写（重放期间由 resume() 统一收尾）
  if (!resumeOwned && (job.status === "done" || job.status === "cancelled")) return;

  const percent = typeof event.percent === "number" && Number.isFinite(event.percent)
    ? clampProgress(event.percent * 100, job.progress)
    : null;

  const patch: Partial<DownloadJob> = { progress: percent === null ? job.progress : percent };
  // 管理页要显示「已下载 / 总大小」与速度：进度帧里本来就有，直接落到 job 上，不另开通道
  const downloadedBytes = byteCount(event.downloadedBytes);
  const totalBytes = byteCount(event.totalBytes);
  const bytesPerSecond = byteCount(event.bytesPerSecond);
  if (downloadedBytes !== undefined) patch.downloadedBytes = downloadedBytes;
  if (totalBytes !== undefined && totalBytes > 0) patch.totalBytes = totalBytes;
  if (bytesPerSecond !== undefined) patch.bytesPerSecond = bytesPerSecond;
  // 只有独立任务在 percent 到 100 时才直接算完成；重放看整次重放的结果
  patch.status = !resumeOwned && percent !== null && percent >= 100 ? "done" : "running";
  if (job.message !== undefined) patch.message = undefined;
  touch(job, patch);
}

/** 任务结束事件（IPC task:done）。 */
export function trackResult(result: TaskResult): void {
  if (!result || typeof result.taskId !== "string") return;
  const scope = installScope.getStore();
  const ownJob = (item: DownloadJob): boolean => scope === undefined || scope.jobIds.has(item.id);
  const job =
    jobs.find((item) => item.id === taskToJob.get(result.taskId)) ??
    jobs.find((item) => item.title === result.label && item.status === "running" && ownJob(item));
  taskToJob.delete(result.taskId);
  if (!job) return;
  // 重放期间子任务的结果不代表整条记录的结局
  if (scope?.ownerId === job.id) return;
  // 取消后的收尾帧（下载已取消 / 任务中止）不能把记录改成 failed
  if (job.status === "cancelled") return;
  if (result.ok) {
    // 完成时保留 totalBytes（管理页要显示「12 MB / 12 MB」），已下载字节对齐到总大小
    const patch: Partial<DownloadJob> = { status: "done", progress: 100, message: undefined, bytesPerSecond: 0 };
    if (typeof job.totalBytes === "number" && job.totalBytes > 0) patch.downloadedBytes = job.totalBytes;
    touch(job, patch);
    return;
  }
  const message = result.error && result.error.trim() ? result.error : mt("dl.messageFailed");
  touch(job, { status: "failed", message });
}

function requireJob(id: string): DownloadJob {
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new Error(mt("dl.recordNotFound", { id }));
  return job;
}

function forgetTasks(jobId: string): void {
  for (const [taskId, mapped] of taskToJob) {
    if (mapped === jobId) taskToJob.delete(taskId);
  }
}

/**
 * 取消：abort 该记录所属安装的句柄，正在跑的传输会立刻断开并抛「下载已取消」。
 * 状态用 cancelled 而不是 failed —— 用户主动取消不算错误，半成品保留，随时能继续。
 */
export async function cancel(id: string): Promise<void> {
  const job = requireJob(id);
  if (job.status === "done" || job.status === "cancelled") return;
  const controller = controllers.get(job.id);
  // 同一次安装派生出的多条记录共用一个句柄：取消一条就把整次安装停下来
  const bound = controller ? jobs.filter((item) => controllers.get(item.id) === controller) : [];
  controller?.abort();
  for (const item of bound.length > 0 ? bound : [job]) {
    if (item.status === "done" || item.status === "cancelled") continue;
    touch(item, { status: "cancelled", message: mt("dl.messageCancelled") });
  }
  // 映射刻意保留：取消后陆续到达的进度帧要落回这条记录并被丢弃，
  // 删掉反而会让它们按 label 建出一条新记录。
  log.info(`已终止下载（${cancelledMessage()}）：${job.title}`);
  await flushPersist();
}

export async function remove(id: string): Promise<void> {
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) throw new Error(mt("dl.recordNotFound", { id }));
  jobs.splice(index, 1);
  controllers.delete(id);
  forgetTasks(id);
  dirty = true;
  schedulePersist();
  scheduleBroadcast();
  await flushPersist();
}

/** 清空已完成（done）的记录；失败/中断的保留，用户还能继续或手动删除。 */
export async function clearFinished(): Promise<void> {
  const keep = jobs.filter((job) => job.status !== "done");
  if (keep.length === jobs.length) return;
  jobs = keep;
  dirty = true;
  schedulePersist();
  scheduleBroadcast();
  await flushPersist();
}

function readParams(job: DownloadJob): Record<string, unknown> {
  const raw = (job.resume ?? "").trim();
  if (!raw) throw new Error(mt("dl.retryMissingParams"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(mt("dl.retryBadJson"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(mt("dl.retryBadShape"));
  }
  return parsed as Record<string, unknown>;
}

function requireString(params: Record<string, unknown>, key: string, label: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(mt("dl.retryMissingField", { field: label }));
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 按 kind 重放对应的安装操作（断点续传由下载器自己的 .part/.part.json 完成）。 */
async function replay(job: DownloadJob, params: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  switch (job.kind) {
    case "version": {
      const mcVersion = requireString(params, "mcVersion", mt("dl.param.mcVersion"));
      await installVersion(mcVersion, signal);
      return;
    }
    case "loader": {
      const mcVersion = requireString(params, "mcVersion", mt("dl.param.mcVersion"));
      const loader = pickEnum(optionalString(params, "loader"), LOADER_KINDS, "vanilla");
      await installLoader({ mcVersion, loader, loaderVersion: optionalString(params, "loaderVersion"), signal });
      return;
    }
    case "java": {
      const major = Number(params.major);
      if (!Number.isInteger(major) || major <= 0) throw new Error(mt("dl.retryMissingMajor"));
      const version = requireString(params, "version", mt("dl.param.version"));
      // 第 3 个参数是下载源（缺省取设置），重试任务沿用设置里的源
      await installJava(major, version, undefined, signal);
      return;
    }
    case "content": {
      const req: ModInstallRequest = {
        provider: pickEnum(optionalString(params, "provider"), PROVIDER_IDS, "modrinth"),
        projectId: requireString(params, "projectId", mt("dl.param.projectId")),
        instanceId: requireString(params, "instanceId", mt("dl.param.instanceId")),
      };
      const fileId = optionalString(params, "fileId");
      if (fileId) req.fileId = fileId;
      const kind = optionalString(params, "kind");
      if (kind) req.kind = pickEnum(kind, CONTENT_KINDS, "mod");
      if (params.installDependencies === true) req.installDependencies = true;
      await installMod(req, signal);
      return;
    }
    default:
      throw new Error(mt("dl.unknownKind", { kind: String(job.kind) }));
  }
}

/** 继续一条记录：按 kind + resume 参数重跑同一个安装操作。 */
export async function resume(id: string): Promise<void> {
  const job = requireJob(id);
  const params = readParams(job);
  // 每次继续都换一个新句柄：上一轮那个多半已经在 cancel 里 abort 过了
  const controller = new AbortController();
  controllers.set(job.id, controller);
  // 不要清零进度：卡片上的百分比是「已落盘的进度」，清零会让用户以为要从头下。
  // 真正的断点续传由下载器的 .part/.part.json 完成，进度会随子任务继续往上走。
  touch(job, { status: "running", message: undefined });
  // 这次重放有自己的上下文：子任务进度归到这条记录，取消只 abort 它自己的句柄
  const scope: InstallScope = { ownerId: job.id, controller, jobIds: new Set<string>([job.id]), hint: null };
  // 要等槽位时先把「排队中」写进记录，免得用户以为任务卡住了
  const gate = installGateState();
  if (gate.queued > 0 || gate.active >= gate.limit) touch(job, { status: "running", message: mt("dl.messageQueued") });
  try {
    await installScope.run(scope, async () => {
      // 继续下载同样受安装闸门约束：排队中被取消会立刻移出队列
      const release = await acquireInstallSlot(controller.signal);
      try {
        touch(job, { message: undefined });
        await replay(job, params, controller.signal);
      } finally {
        release();
      }
    });
    // 传输中途被取消：状态由 cancel() 写成 cancelled，这里不能再改回 done
    if (controller.signal.aborted) return;
    touch(job, { status: "done", progress: 100, message: undefined });
  } catch (err) {
    if (controller.signal.aborted || isCancelledError(err)) {
      log.info(`${cancelledMessage()}：${job.title}（记录保持可继续）`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    touch(job, { status: "failed", message });
    log.warn(`继续下载失败：${job.title} · ${message}`);
    throw err instanceof Error ? err : new Error(message);
  } finally {
    if (controllers.get(job.id) === controller) controllers.delete(job.id);
    await flushPersist();
  }
}

/** 是否已经 load 过（调试/测试用）。 */
export function isLoaded(): boolean {
  return loaded;
}
