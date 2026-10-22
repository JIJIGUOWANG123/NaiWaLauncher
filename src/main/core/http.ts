import { createHash } from "node:crypto";
import dns from "node:dns";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

import type { DownloadSourceId } from "../../shared/types";
import type { TaskHandle } from "./events";
import { logger } from "./logger";
import { getSettings } from "./settings";
import { mapUrl, resolveBase } from "./sources";

export interface DownloadOptions {
  task?: TaskHandle;
  expectedSha1?: string;
  connections?: number;
  label?: string;
  headers?: Record<string, string>;
  /** 取消信号：abort 时中断传输并抛「下载已取消」，半成品与续传记录保留。 */
  signal?: AbortSignal;
}

const log = logger("http");

// 双栈网络下 Fastly 等 CDN 的 IPv6 节点会被黑洞，undici 要卡满 10s 连接超时才失败；
// 实测 cdn.modrinth.com 优先 IPv4 后连接失败率从 1/6 降到 0/15。
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* 旧版 Node 无此 API，忽略 */
}

const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
/** 只约束"拿到响应头"这一段，正文不受它限制。 */
// 冷连接（cdn.modrinth.com 的 TLS 握手）实测可达 7.6s，6s 会误判超时
const HEADER_TIMEOUT_MS = 15_000;
/** 单个分片两次收到数据之间的最大容忍时间。 */
// 60s 太长：一条卡死的连接会占住一个 worker 槽位整整一分钟（分片还会再重试一次），
// 并行下载时这条代价被放大；30s 足够覆盖正常的慢响应，又能把槽位尽快还给池子。
const STALL_TIMEOUT_MS = 30_000;
const CHUNK_ATTEMPTS = 2;
const STREAM_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;
/** 小于此体积直接单连接下载：多连接只是多付握手与限流风险。 */
const SMALL_FILE_BYTES = 2 * 1024 * 1024;
const MIN_CHUNK_BYTES = 512 * 1024;
const PROGRESS_INTERVAL_MS = 200;
const SHA1_ATTEMPTS = 2;

/** 取消时的统一错误信息：上层据此把「用户取消」和真实失败区分开。 */
export const CANCELLED_MESSAGE = "下载已取消";

function cancelledError(): Error {
  const err = new Error(CANCELLED_MESSAGE) as Error & { cancelled?: boolean };
  err.name = "CancelledError";
  err.cancelled = true;
  return err;
}

/** 错误是否来自取消（而不是网络/校验/超时）。 */
export function isCancelledError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { cancelled?: unknown }).cancelled === true;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

/**
 * 把调用方的取消信号并到本地超时信号上：任一 abort 都断开连接。
 * release() 必须调用，否则每开一次连接都会在调用方的 signal 上挂一个监听器。
 */
function linkSignals(parent: AbortSignal | undefined, child: AbortSignal): { signal: AbortSignal; release(): void } {
  if (!parent) return { signal: child, release: () => undefined };
  const controller = new AbortController();
  const relay = (): void => controller.abort();
  if (parent.aborted || child.aborted) controller.abort();
  else {
    parent.addEventListener("abort", relay, { once: true });
    child.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    release: () => {
      parent.removeEventListener("abort", relay);
      child.removeEventListener("abort", relay);
    },
  };
}

/** 只用于 Promise.race 的失败分支：预先吞掉拒绝，避免竞速输掉后残留未处理异常。 */
function rejectLater(run: (reject: (err: Error) => void) => void): Promise<never> {
  const promise = new Promise<never>((_, reject) => run(reject));
  promise.catch(() => undefined);
  return promise;
}

interface ChunkState {
  index: number;
  start: number;
  end: number;
  done: number;
}

interface PartMeta {
  url: string;
  size: number;
  etag: string;
  chunks: ChunkState[];
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

interface RemoteInfo {
  size: number;
  acceptRanges: boolean;
  etag: string;
}

interface TransferContext {
  connections: number;
  task?: TaskHandle;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status?: number };
  err.name = "HttpError";
  (err as Error & { status?: number }).status = status;
  return err;
}

function statusOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

/** 403/404 这类错误重试也不会变好，必须快速失败。 */
function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === null) return true;
  return status === 408 || status === 429 || status >= 500;
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* 已关闭 */
  }
}

function readerOf(res: Response): ByteReader {
  if (!res.body) throw new Error("响应没有正文");
  return res.body.getReader() as unknown as ByteReader;
}

async function readWithTimeout(
  reader: ByteReader,
  ms: number,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const races: Promise<{ done: boolean; value?: Uint8Array }>[] = [
    reader.read(),
    rejectLater((reject) => {
      timer = setTimeout(() => reject(new Error("下载超时：长时间没有收到数据")), ms);
    }),
  ];
  if (signal) {
    // 取消不必等 60s 的停滞超时：read() 会一直挂着，必须由 abort 直接把这一帧打断
    races.push(
      rejectLater((reject) => {
        const fail = (): void => reject(cancelledError());
        if (signal.aborted) {
          fail();
          return;
        }
        onAbort = fail;
        signal.addEventListener("abort", fail, { once: true });
      }),
    );
  }
  try {
    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

interface Target {
  source: DownloadSourceId;
  url: string;
}

function sourceLabel(source: DownloadSourceId): string {
  switch (source) {
    case "official":
      return "官方";
    case "bmclapi":
      return "BMCLAPI";
    case "sjtu":
      return "上海交大";
    default:
      return "自动";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 失败原因的可读描述：优先状态码，其次截断的错误文本。 */
function describeError(err: unknown): string {
  const status = statusOf(err);
  if (status !== null) return `HTTP ${status}`;
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 60 ? `${message.slice(0, 60)}…` : message;
}

/**
 * 官方地址 → 1 个主源 + 至多 1 个备用源。
 * 镜像会缺个别对象（如 log_configs），此时要用官方兜一次，而不是让整个安装失败。
 * 未收录域名（API 等）映射结果相同，等于只有主源、不产生额外流量。
 */
function sourceTargets(url: string, allowMirror: boolean): Target[] {
  if (!allowMirror) return [{ source: "official", url }];
  const active = getSettings().downloadSource;
  const primary: DownloadSourceId = active === "auto" ? resolveBase("auto") : active;
  const alternate: DownloadSourceId = primary === "bmclapi" ? "official" : "bmclapi";
  const list: Target[] = [{ source: primary, url: mapUrl(url, primary) }];
  const altUrl = mapUrl(url, alternate);
  if (altUrl !== list[0].url) list.push({ source: alternate, url: altUrl });
  return list;
}

async function fetchTextOnce(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  throwIfCancelled(signal);
  const timer = timeoutSignal(timeoutMs);
  const link = linkSignals(signal, timer.signal);
  try {
    const res = await fetch(url, {
      // 默认 UA 与调用方 headers 合并，调用方优先（Modrinth 强制 UA、CurseForge 需要 key）
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers },
      redirect: "follow",
      signal: link.signal,
    });
    if (!res.ok) {
      await cancelBody(res);
      throw httpError(res.status, `HTTP ${res.status} ${res.statusText} · ${url}`);
    }
    if (signal?.aborted) {
      await cancelBody(res);
      throw cancelledError();
    }
    return await res.text();
  } catch (err) {
    // 先看调用方信号：超时与取消都是 AbortError，但取消必须原样上抛
    if (signal?.aborted) throw cancelledError();
    if (err instanceof Error && err.name === "AbortError") throw new Error(`请求超时（${timeoutMs}ms）· ${url}`);
    throw err;
  } finally {
    link.release();
    timer.cancel();
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  allowMirror?: boolean;
  headers?: Record<string, string>;
  /** 取消信号：abort 时立刻放弃请求（含重试与跨源回退）并抛「下载已取消」。 */
  signal?: AbortSignal;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(1, opts.retries ?? DEFAULT_RETRIES);
  const targets = sourceTargets(url, opts.allowMirror !== false);

  const failures: string[] = [];
  let lastError: unknown = null;
  for (let index = 0; index < targets.length; index += 1) {
    throwIfCancelled(opts.signal);
    const target = targets[index];
    let error: unknown = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        // 镜像只改写 URL，headers 原样透传
        return await fetchTextOnce(target.url, timeoutMs, opts.headers, opts.signal);
      } catch (err) {
        // 取消不重试、也不换源
        if (opts.signal?.aborted || isCancelledError(err)) throw cancelledError();
        error = err;
        // 404/403 在同源上重试没有意义，立刻交给备用源
        if (!isRetryable(err) || attempt === retries - 1) break;
        await sleep(300 * 2 ** attempt);
      }
    }
    lastError = error;
    failures.push(`${sourceLabel(target.source)} ${describeError(error)}`);
    const next = targets[index + 1];
    if (next) {
      log.warn(
        `跨源回退：${hostOf(target.url)} 在${sourceLabel(target.source)}失败（${describeError(error)}），改用${sourceLabel(next.source)}`,
      );
    }
  }

  if (targets.length > 1) throw new Error(`镜像与官方均失败：${failures.join("；")} · ${url}`);
  throw lastError instanceof Error ? lastError : new Error(`请求失败 · ${url}`);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`JSON 解析失败 · ${url}`);
  }
}

/** 滑动窗口测速：按最近 3 秒均值上报，避免界面数字乱跳。 */
class SpeedMeter {
  private samples: { t: number; bytes: number }[] = [];

  constructor(private readonly windowMs = 3000) {}

  rate(bytes: number): number {
    const now = Date.now();
    this.samples.push({ t: now, bytes });
    while (this.samples.length > 2 && now - this.samples[0].t > this.windowMs) this.samples.shift();
    const first = this.samples[0] ?? { t: now, bytes };
    const seconds = (now - first.t) / 1000;
    if (seconds < 0.2) return 0;
    return Math.max(0, Math.round((bytes - first.bytes) / seconds));
  }
}

/** 限速（KB/s）→ 字节/秒；0 或非法值表示不限速。每次调用都重读设置，改设置立即生效。 */
function speedLimitBytesPerSecond(): number {
  const kbps = getSettings().speedLimitKbps;
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  return kbps * 1024;
}

/** 桶容量：限速越低越容易被一次 chunk 打穿，至少留 16KB 才能容纳一次普通读取。 */
function burstBytes(limit: number): number {
  return Math.max(16 * 1024, Math.min(limit * 0.5, 4 * 1024 * 1024));
}

/**
 * 进程级令牌桶：单流与所有分片连接共用同一份预算，4 条连接不会变成 4 倍上限。
 * 记账允许透支，透支额换算成等待时间，所以平均速率严格等于限速；
 * 结算串行化，否则并发连接同时算等待会一起醒来把总量放大。
 */
class RateLimiter {
  private tokens = 0;
  private stamp = Date.now();
  /** 上一轮结算用的限速：调高限速时不能拿新值去补已经过去的时间，否则会白送一大笔预算。 */
  private lastLimit = 0;
  private queue: Promise<void> = Promise.resolve();

  async consume(bytes: number): Promise<void> {
    const run = this.queue.then(() => this.settle(bytes));
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async settle(bytes: number): Promise<void> {
    let limit = speedLimitBytesPerSecond();
    if (limit <= 0) {
      this.tokens = 0;
      return;
    }
    this.refill(limit);
    this.tokens -= bytes;
    for (;;) {
      // 等待期间也要重读：把限速调大要立刻缩短等待，关掉限速则剩余欠账作废
      limit = speedLimitBytesPerSecond();
      if (limit <= 0) {
        this.tokens = 0;
        return;
      }
      this.refill(limit);
      if (this.tokens >= 0) return;
      const waitMs = Math.ceil((-this.tokens / limit) * 1000);
      // 不足 1ms 的欠账留给下一次结算：避免高限速下被 1ms 定时器量化成上限
      if (waitMs <= 0) return;
      await sleep(waitMs);
    }
  }

  private refill(limit: number): void {
    const now = Date.now();
    const elapsed = (now - this.stamp) / 1000;
    const rate = this.lastLimit;
    this.lastLimit = limit;
    if (elapsed <= 0) return;
    this.tokens = Math.min(burstBytes(limit), this.tokens + elapsed * rate);
    this.stamp = now;
  }
}

const rateLimiter = new RateLimiter();

/** 下载限速入口：不限速时直接返回，不进队列、不产生定时器。 */
async function throttle(bytes: number): Promise<void> {
  if (speedLimitBytesPerSecond() <= 0) return;
  await rateLimiter.consume(bytes);
}

function metaPath(dest: string): string {
  return `${dest}.part.json`;
}

async function statFile(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function sha1OfFile(file: string): Promise<string> {
  const hash = createHash("sha1");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** 清掉半成品与续传记录；换源或校验失败时必须清理，否则会续传错误字节。 */
async function discardPartial(dest: string): Promise<void> {
  await rm(dest, { force: true }).catch(() => undefined);
  await rm(metaPath(dest), { force: true }).catch(() => undefined);
}

async function saveMeta(dest: string, meta: PartMeta): Promise<void> {
  await writeFile(metaPath(dest), JSON.stringify(meta), "utf8").catch(() => undefined);
}

async function readMeta(dest: string): Promise<PartMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPath(dest), "utf8")) as PartMeta;
    if (!parsed || !Array.isArray(parsed.chunks) || parsed.chunks.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface StreamInfo {
  res: Response;
  size: number;
  acceptRanges: boolean;
  etag: string;
}

/**
 * 直接发 GET：一次往返同时拿到正文、长度与 Range 能力，不再单独发 HEAD。
 * 探测慢或对 HEAD 限流的 CDN 上，这一步省掉的就是秒级抖动。
 */
async function openGet(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<StreamInfo> {
  throwIfCancelled(signal);
  const connect = timeoutSignal(HEADER_TIMEOUT_MS);
  const link = linkSignals(signal, connect.signal);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, ...headers },
      redirect: "follow",
      signal: link.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw cancelledError();
    if (err instanceof Error && err.name === "AbortError") throw new Error(`连接超时（${HEADER_TIMEOUT_MS}ms）· ${url}`);
    throw err;
  } finally {
    // 定时器必须在拿到响应头后立刻清掉，否则会把正常的长正文拖到 abort
    link.release();
    connect.cancel();
  }
  if (signal?.aborted) {
    await cancelBody(res);
    throw cancelledError();
  }
  if (!res.ok) {
    await cancelBody(res);
    throw httpError(res.status, `HTTP ${res.status} ${res.statusText} · ${url}`);
  }
  const length = Number(res.headers.get("content-length") ?? Number.NaN);
  const known = Number.isFinite(length) && length > 0;
  return {
    res,
    size: known ? length : -1,
    acceptRanges: /bytes/i.test(res.headers.get("accept-ranges") ?? ""),
    etag: res.headers.get("etag") ?? `len-${known ? length : "unknown"}`,
  };
}

function freshMeta(url: string, size: number, etag: string, chunkCount: number): PartMeta {
  const chunks: ChunkState[] = [];
  const per = Math.ceil(size / chunkCount);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * per;
    const end = Math.min(size - 1, start + per - 1);
    if (start > end) break;
    chunks.push({ index, start, end, done: 0 });
  }
  return { url, size, etag, chunks };
}

function validateMeta(meta: PartMeta, info: RemoteInfo): PartMeta | null {
  // 远端文件变了（大小/ETag）就不能复用已有字节
  if (meta.size !== info.size || meta.etag !== info.etag) return null;
  for (const chunk of meta.chunks) {
    const length = chunk.end - chunk.start + 1;
    if (!Number.isFinite(chunk.start) || !Number.isFinite(chunk.end) || chunk.end < chunk.start) return null;
    if (!Number.isFinite(chunk.done) || chunk.done < 0 || chunk.done > length) return null;
  }
  return meta;
}

async function prepareMeta(dest: string, url: string, info: RemoteInfo, chunkCount: number): Promise<PartMeta> {
  const existing = await readMeta(dest);
  if (existing && existing.url === url) {
    const valid = validateMeta(existing, info);
    // 文件长度必须与远端一致，否则已有字节位置不可信
    if (valid && (await statFile(dest)) === info.size) return valid;
  }
  const meta = freshMeta(url, info.size, info.etag, chunkCount);
  await saveMeta(dest, meta);
  return meta;
}

/** 以 r+ 打开（可定位写入）；文件不存在时先建空文件，避免 ENOENT。 */
async function openForWrite(dest: string): Promise<FileHandle> {
  try {
    return await open(dest, "r+");
  } catch {
    await writeFile(dest, "");
    return await open(dest, "r+");
  }
}

async function pumpToFile(
  reader: ByteReader,
  handle: FileHandle,
  chunk: ChunkState,
  onBytes: (delta: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  try {
    for (;;) {
      const { done, value } = await readWithTimeout(reader, STALL_TIMEOUT_MS, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      // 先等预算再落盘计数：下一次 read 也会因此被推迟，形成对服务端的真实背压，
      // 而进度里的速度只统计被放行的字节，天然是限速后的值。
      await throttle(buf.length);
      // 限速等待期间可能已经被取消：不要再往盘上写
      throwIfCancelled(signal);
      await handle.write(buf, 0, buf.length, chunk.start + chunk.done);
      chunk.done += buf.length;
      onBytes(buf.length);
    }
  } catch (err) {
    // 取消要立刻断开这条连接，否则 socket 会挂在后台继续把流量跑完
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    throw err;
  }
}

async function runChunk(
  handle: FileHandle,
  url: string,
  chunk: ChunkState,
  headers: Record<string, string>,
  onBytes: (delta: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const length = chunk.end - chunk.start + 1;
  let attempt = 0;
  while (chunk.done < length) {
    throwIfCancelled(signal);
    attempt += 1;
    const from = chunk.start + chunk.done;
    const connect = timeoutSignal(HEADER_TIMEOUT_MS);
    const link = linkSignals(signal, connect.signal);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, ...headers, range: `bytes=${from}-${chunk.end}` },
        redirect: "follow",
        signal: link.signal,
      });
    } catch (err) {
      link.release();
      connect.cancel();
      if (signal?.aborted) throw cancelledError();
      if (!isRetryable(err) || attempt >= CHUNK_ATTEMPTS) throw err instanceof Error ? err : new Error(String(err));
      await sleep(RETRY_BACKOFF_MS * attempt);
      continue;
    }
    link.release();
    connect.cancel();
    try {
      if (res.status !== 206) {
        await cancelBody(res);
        throw httpError(
          res.status,
          res.ok ? `服务器不支持分段下载（HTTP ${res.status}）` : `HTTP ${res.status} ${res.statusText} · ${url}`,
        );
      }
      await pumpToFile(readerOf(res), handle, chunk, onBytes, signal);
    } catch (err) {
      if (signal?.aborted || isCancelledError(err)) throw cancelledError();
      if (!isRetryable(err) || attempt >= CHUNK_ATTEMPTS) throw err instanceof Error ? err : new Error(String(err));
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
}

async function transferChunked(
  url: string,
  dest: string,
  headers: Record<string, string>,
  info: RemoteInfo,
  connections: number,
  onBytes: (delta: number, connections: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  throwIfCancelled(signal);
  const size = info.size;
  const chunkCount = Math.max(1, Math.min(connections, Math.floor(size / MIN_CHUNK_BYTES)));
  const meta = await prepareMeta(dest, url, info, chunkCount);
  const metaTimer = setInterval(() => {
    void saveMeta(dest, meta);
  }, 1000);
  metaTimer.unref?.();

  let handle: FileHandle | null = null;
  try {
    handle = await openForWrite(dest);
    await handle.truncate(size);
    const fileHandle = handle;
    // 分片全并行写同一文件的各自偏移：没有合并步骤，也不逐片串行落盘。
    // 用 allSettled 而不是 all：取消时其余分片也要各自收尾，别在句柄关闭后才去写盘。
    const settled = await Promise.allSettled(
      meta.chunks.map((chunk) =>
        runChunk(fileHandle, url, chunk, headers, (delta) => onBytes(delta, meta.chunks.length), signal),
      ),
    );
    // 取消也要落一次续传记录：已到手的字节就是下次 resume 的起点
    await saveMeta(dest, meta);
    const failure = settled.find((item) => item.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;
  } finally {
    clearInterval(metaTimer);
    if (handle) await handle.close().catch(() => undefined);
  }

  await rm(metaPath(dest), { force: true }).catch(() => undefined);
  return (await statFile(dest)) ?? size;
}

async function transfer(url: string, dest: string, ctx: TransferContext): Promise<number> {
  const headers = ctx.headers ?? {};
  const meter = new SpeedMeter();
  let received = 0;
  let lastReport = 0;

  const report = (force: boolean, totalBytes: number, connections: number): void => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    ctx.task?.update({
      stage: "下载",
      downloadedBytes: received,
      totalBytes: Math.max(0, totalBytes),
      percent: totalBytes > 0 ? Math.min(1, received / totalBytes) : null,
      bytesPerSecond: meter.rate(received),
      connections,
    });
  };

  let attempt = 0;
  for (;;) {
    throwIfCancelled(ctx.signal);
    attempt += 1;
    let opened: StreamInfo;
    try {
      opened = await openGet(url, headers, ctx.signal);
    } catch (err) {
      if (ctx.signal?.aborted || isCancelledError(err)) throw cancelledError();
      if (!isRetryable(err) || attempt >= STREAM_ATTEMPTS) throw err instanceof Error ? err : new Error(String(err));
      await sleep(RETRY_BACKOFF_MS * attempt);
      continue;
    }

    const size = opened.size;
    if (size >= SMALL_FILE_BYTES && opened.acceptRanges && ctx.connections > 1) {
      // 大文件：这条响应只用来读头，正文直接丢弃，转分片下载（支持续传）
      await cancelBody(opened.res);
      const info: RemoteInfo = { size, acceptRanges: true, etag: opened.etag };
      const existing = await readMeta(dest);
      received = existing && existing.url === url ? existing.chunks.reduce((sum, c) => sum + (Number.isFinite(c.done) ? c.done : 0), 0) : 0;
      report(true, size, ctx.connections);
      const bytes = await transferChunked(
        url,
        dest,
        headers,
        info,
        ctx.connections,
        (delta, conns) => {
          received += delta;
          report(false, size, conns);
        },
        ctx.signal,
      );
      report(true, size, ctx.connections);
      return bytes;
    }

    // 小文件 / 不支持 Range / 长度未知：直接用这条已建立的连接写完
    received = 0;
    report(true, Math.max(0, size), 1);
    const tempDest = `${dest}.partial`;
    const handle = await open(tempDest, "w");
    try {
      const chunk: ChunkState = { index: 0, start: 0, end: Number.MAX_SAFE_INTEGER, done: 0 };
      await pumpToFile(
        readerOf(opened.res),
        handle,
        chunk,
        (delta) => {
          received += delta;
          report(false, Math.max(0, size), 1);
        },
        ctx.signal,
      );
      await handle.close().catch(() => undefined);
      // 先写临时文件再改名：半截文件不会冒充"已完成"
      await rename(tempDest, dest);
      await rm(metaPath(dest), { force: true }).catch(() => undefined);
      report(true, Math.max(0, size), 1);
      return size > 0 ? size : received;
    } catch (err) {
      await cancelBody(opened.res);
      await handle.close().catch(() => undefined);
      if (ctx.signal?.aborted || isCancelledError(err)) {
        // 取消：半成品保留在原处，下次 resume 从断点续
        throw cancelledError();
      }
      await rm(tempDest, { force: true }).catch(() => undefined);
      if (!isRetryable(err) || attempt >= STREAM_ATTEMPTS) throw err instanceof Error ? err : new Error(String(err));
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
}

export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<{ bytes: number; reused: boolean }> {
  const settings = getSettings();
  const signal = opts.signal;
  throwIfCancelled(signal);
  const connections = clampInt(opts.connections ?? settings.connectionsPerFile, 1, 16, settings.connectionsPerFile);
  await mkdir(dirname(dest), { recursive: true });

  const expected = opts.expectedSha1?.toLowerCase();
  const existingSize = await statFile(dest);
  const hasPartial = (await statFile(metaPath(dest))) !== null;

  if (existingSize !== null) {
    if (expected) {
      if ((await sha1OfFile(dest)) === expected) {
        if (hasPartial) await rm(metaPath(dest), { force: true }).catch(() => undefined);
        return { bytes: existingSize, reused: true };
      }
      await discardPartial(dest);
    } else if (!hasPartial && existingSize > 0) {
      return { bytes: existingSize, reused: true };
    }
  } else if (hasPartial) {
    // 只剩续传记录没有文件：记录作废
    await rm(metaPath(dest), { force: true }).catch(() => undefined);
  }

  const targets = sourceTargets(url, true);
  const failures: string[] = [];
  let lastError: unknown = null;
  for (let index = 0; index < targets.length; index += 1) {
    throwIfCancelled(signal);
    const target = targets[index];
    let error: unknown = null;
    for (let attempt = 1; attempt <= SHA1_ATTEMPTS; attempt += 1) {
      try {
        const bytes = await transfer(target.url, dest, { connections, task: opts.task, headers: opts.headers, signal });
        if (expected) {
          const actual = await sha1OfFile(dest);
          if (actual !== expected) {
            await discardPartial(dest);
            const mismatch = new Error(`SHA1 校验失败：期望 ${expected}，实际 ${actual} · ${target.url}`);
            // 校验失败重下一次，仍失败才算真失败
            if (attempt >= SHA1_ATTEMPTS) throw mismatch;
            log.warn(mismatch.message + "（重试一次）");
            continue;
          }
        }
        return { bytes, reused: false };
      } catch (err) {
        // 取消：不清理半成品、不重试、不换源，直接把「下载已取消」交给上层
        if (signal?.aborted || isCancelledError(err)) {
          log.info(`${CANCELLED_MESSAGE} · ${dest}`);
          throw isCancelledError(err) ? err : cancelledError();
        }
        error = err;
        await discardPartial(dest);
        // 同源重试已在 transfer 内部做过（连接/分片各 2 次），这里直接交给备用源
        break;
      }
    }
    lastError = error;
    failures.push(`${sourceLabel(target.source)} ${describeError(error)}`);
    const next = targets[index + 1];
    if (next) {
      log.warn(
        `跨源回退：${hostOf(url)} 在${sourceLabel(target.source)}失败（${describeError(error)}），改用${sourceLabel(next.source)}`,
      );
    }
  }

  // 两个源都挂：错误里保留两端状态码，别让上层只看到一个 404
  if (targets.length > 1) throw new Error(`镜像与官方均失败：${failures.join("；")} · ${url}`);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function downloadMany(
  items: { url: string; dest: string; sha1?: string; size?: number }[],
  opts: {
    task?: TaskHandle;
    concurrent?: number;
    connections?: number;
    label?: string;
    /** 取消信号：abort 时不再起新文件，并把「下载已取消」抛给上层。 */
    signal?: AbortSignal;
  } = {},
): Promise<{ failed: { url: string; dest: string; error: string }[] }> {
  const signal = opts.signal;
  throwIfCancelled(signal);
  const settings = getSettings();
  const concurrent = clampInt(opts.concurrent ?? settings.concurrentDownloads, 1, 32, settings.concurrentDownloads);
  const connections = clampInt(opts.connections ?? settings.connectionsPerFile, 1, 16, settings.connectionsPerFile);
  const task = opts.task;
  const totalFiles = items.length;
  const knownTotal = items.every((item) => typeof item.size === "number" && (item.size ?? 0) > 0);
  const totalBytes = items.reduce((sum, item) => sum + (item.size ?? 0), 0);
  const active = new Map<number, number>();
  const meter = new SpeedMeter();
  let completedBytes = 0;
  let filesDone = 0;
  let lastReport = 0;
  /** 槽位编号：两轮池子共用同一份 active 计数，用全局编号避免与上一轮的键撞车。 */
  let slotId = 0;

  const report = (force = false): void => {
    if (!task) return;
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    let inflight = 0;
    for (const value of active.values()) inflight += value;
    const downloaded = completedBytes + inflight;
    task.update({
      stage: opts.label ?? "下载",
      downloadedBytes: downloaded,
      totalBytes: knownTotal ? totalBytes : 0,
      percent: knownTotal && totalBytes > 0 ? Math.min(1, downloaded / totalBytes) : null,
      bytesPerSecond: meter.rate(downloaded),
      filesDone,
      filesTotal: items.length,
      connections: concurrent,
    });
  };

  // 一个 worker 独占一个文件直到下完：走 Small file 单连接路径的文件也各自占一个 worker 槽位，
  // 与走多分片的文件并行推进，不会因为只开一条连接就被串行化。
  // 抽成函数是为了让"失败补下一轮"复用同一个池子，而不是把并发逻辑再写一遍。
  const runBatch = async (
    batch: { url: string; dest: string; sha1?: string; size?: number }[],
    batchConnections: number,
  ): Promise<{ url: string; dest: string; error: string }[]> => {
    const failures: { url: string; dest: string; error: string }[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        // 取消后不再领新文件：已领到的会各自中断，队列里的不再下载
        if (signal?.aborted) return;
        const position = cursor;
        cursor += 1;
        if (position >= batch.length) return;
        const item = batch[position];
        const slot = slotId;
        slotId += 1;
        // 代理句柄只把字节汇总到父任务，不单独推送事件
        const proxy: TaskHandle = {
          id: `${task?.id ?? "batch"}-${slot}`,
          kind: task?.kind ?? "generic",
          label: item.dest,
          update: (p) => {
            if (typeof p.downloadedBytes === "number") {
              active.set(slot, Math.max(active.get(slot) ?? 0, p.downloadedBytes));
            }
            report();
          },
          done: () => undefined,
          fail: () => undefined,
        };
        try {
          const result = await downloadFile(item.url, item.dest, {
            expectedSha1: item.sha1,
            connections: batchConnections,
            task: proxy,
            signal,
          });
          active.delete(slot);
          completedBytes += result.bytes;
        } catch (err) {
          active.delete(slot);
          // 取消不是文件失败：不往失败清单里记，交给调用方统一抛
          if (signal?.aborted || isCancelledError(err)) return;
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ url: item.url, dest: item.dest, error: message });
          log.warn(`文件下载失败：${item.dest} · ${message}`);
        }
        filesDone += 1;
        report(true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrent, batch.length) }, () => worker()));
    return failures;
  };

  // 首轮：并发 concurrent 个文件同时下载
  report(true);
  let failed = await runBatch(items, connections);
  report(true);
  throwIfCancelled(signal);

  // 卡流、瞬时 5xx 在 CDN 上很常见：整批结束后用同一个池子把失败的那些补下一轮（只补一次）。
  // 每文件连接数减半（最多 4）：首轮失败多半是某条分片连接卡死，再开 4 条只会更快撞上同一处限流。
  // 取消时不补：用户已经要求停下，重试只会拖时间。
  if (failed.length > 0 && !signal?.aborted) {
    const retryConnections = Math.max(1, Math.min(4, Math.floor(connections / 2)));
    const byDest = new Map(items.map((item) => [item.dest, item] as const));
    const retryItems = failed.map((item) => {
      const original = byDest.get(item.dest);
      return {
        url: item.url,
        dest: item.dest,
        ...(original?.sha1 ? { sha1: original.sha1 } : {}),
        ...(typeof original?.size === "number" ? { size: original.size } : {}),
      };
    });
    log.warn(
      `首轮失败 ${failed.length} 个，正在重试（并发 ${Math.min(concurrent, retryItems.length)}，每文件连接 ${retryConnections}）`,
    );
    // 重试的文件退回"未完成"：进度不会越过总数
    filesDone = Math.max(0, filesDone - failed.length);
    report(true);
    failed = await runBatch(retryItems, retryConnections);
    if (failed.length > 0) {
      log.warn(`重试后仍失败 ${failed.length} 个：${failed.map((item) => item.dest).join("、")}`);
    } else {
      log.info(`重试补齐 ${retryItems.length} 个文件`);
    }
    report(true);
  }

  throwIfCancelled(signal);
  // 单文件失败不影响其它文件，但整批结束后必须留下可追溯的汇总，否则只在日志里散落几条 warn
  if (failed.length > 0) {
    const first = failed[0];
    log.warn(
      "批量下载完成：成功 " + (totalFiles - failed.length) + "/" + totalFiles + " 个，失败 " + failed.length + " 个（首个：" + first.dest + " · " + first.error + "）",
    );
  }
  return { failed };
}
