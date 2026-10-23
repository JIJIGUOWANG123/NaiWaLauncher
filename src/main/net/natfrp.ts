import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NatfrpStatus, NatfrpTunnel, NatfrpUser } from "../../shared/types";
import { downloadFile } from "../core/http";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { mt } from "../core/i18n";

const log = logger("natfrp");

const BASE = "https://api.natfrp.com/v4";
const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const TIMEOUT_MS = 20_000;
const MAX_LOG_LINES = 200;
const KEEP_LOG_LINES = 50;
/** 节点 flag 第 11 位：允许穿透公开游戏服务器。 */
const PUBLIC_GAME_FLAG = 2048;
/** 先 SIGTERM，等这么久还没退出才用 taskkill /F 收进程树。 */
const KILL_GRACE_MS = 1500;
const DEFAULT_LOCAL_IP = "127.0.0.1";
const DEFAULT_LOCAL_PORT = 25565;

function missingToken(): string {
  return mt("net.natfrp.missingToken");
}

interface NatfrpState {
  child: ChildProcess | null;
  tunnelId: number | null;
  address: string;
  log: string[];
  /** 已下载的 frpc 版本号，作为 /tunnel/config 的 frpc 参数。 */
  frpcVersion: string;
}

const state: NatfrpState = { child: null, tunnelId: null, address: "", log: [], frpcVersion: "" };

// ---------- 基础工具 ----------

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }
  return fallback;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireToken(): string {
  const token = getSettings().natfrpToken.trim();
  if (!token) throw new Error(missingToken());
  return token;
}

function toolsDir(): string {
  return join(getPaths().dataRoot, "tools");
}

function frpcExePath(): string {
  return join(toolsDir(), "frpc.exe");
}

function netDir(): string {
  return join(getPaths().dataRoot, "net");
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function hashOfFile(path: string, algorithm: "md5" | "sha1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 按返回值长度判断算法：32 位是 MD5、40 位是 SHA1，其它长度视为拿不到。 */
function hashAlgorithm(hash: string): "md5" | "sha1" | null {
  if (/^[0-9a-f]{32}$/.test(hash)) return "md5";
  if (/^[0-9a-f]{40}$/.test(hash)) return "sha1";
  return null;
}

// ---------- HTTP ----------

interface ApiRaw {
  status: number;
  text: string;
  contentType: string;
}

interface ApiOptions {
  method?: "GET" | "POST";
  form?: Record<string, string | number>;
  /** /system/clients 等公开接口免鉴权。 */
  auth?: boolean;
}

async function request(path: string, opts: ApiOptions = {}): Promise<ApiRaw> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json, text/plain, */*",
  };
  if (opts.auth !== false) headers.authorization = `Bearer ${requireToken()}`;
  let body: string | undefined;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(Object.entries(opts.form).map(([key, value]) => [key, String(value)])).toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: opts.method ?? "GET", headers, body, redirect: "follow", signal: controller.signal });
    return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(mt("net.natfrp.timeout", { ms: TIMEOUT_MS, path }));
    throw new Error(mt("net.natfrp.unavailable", { error: errorMessage(err), path }));
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * 服务端错误统一是 { code, msg }，且常以 HTTP 500 返回（实测鉴权失败就是 500 + code 401），
 * 所以状态码和正文里的 code 都要看，最终把 code/msg 原文带进错误文案。
 */
function serverError(path: string, raw: ApiRaw, json: unknown): Error {
  const body = jsonObject(json);
  const code = jsonNumber(body.code, raw.status);
  const msg = jsonString(body.msg) || jsonString(body.message);
  const text = msg ? mt("net.natfrp.replyCode", { code, msg }) : mt("net.natfrp.replyHttp", { status: raw.status });
  const err = new Error(`${text} · ${path}`) as Error & { code?: number; status?: number };
  err.code = code;
  err.status = code;
  return err;
}

async function apiJson<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const raw = await request(path, opts);
  const json = parseJson(raw.text);
  const bodyCode = jsonNumber(jsonObject(json).code);
  if (raw.status < 200 || raw.status >= 300 || bodyCode >= 400) throw serverError(path, raw, json);
  if (json === undefined) throw new Error(mt("net.natfrp.badJson", { path }));
  return json as T;
}

/** 纯文本接口（/tunnel/config）：JSON 正文一律当错误处理。 */
async function apiText(path: string, opts: ApiOptions = {}): Promise<{ text: string; contentType: string }> {
  const raw = await request(path, opts);
  const json = parseJson(raw.text);
  if (raw.status < 200 || raw.status >= 300 || json !== undefined) throw serverError(path, raw, json);
  return { text: raw.text, contentType: raw.contentType };
}

// ---------- 账号 ----------

function toUser(raw: unknown): NatfrpUser {
  const user = jsonObject(raw);
  const id = jsonNumber(user.id);
  if (!id) throw new Error(mt("net.natfrp.noUserId"));
  const ban = jsonObject(user.ban);
  const banTitle = jsonString(ban.title);
  if (banTitle) throw new Error(mt("net.natfrp.banned", { title: banTitle, reason: jsonString(ban.reason) ? "（" + jsonString(ban.reason) + "）" : "" }));

  // traffic = [本日已消耗, 总剩余流量]（字节）；sign 只做只读展示
  const traffic = jsonArray(user.traffic);
  const sign = jsonObject(user.sign);
  return {
    id,
    name: jsonString(user.name) || `#${id}`,
    email: jsonString(user.email) || undefined,
    trafficToday: optionalNumber(traffic[0]),
    trafficLeft: optionalNumber(traffic[1]),
    groupName: jsonString(jsonObject(user.group).name) || undefined,
    signed: sign.signed === true,
    signDays: optionalNumber(sign.days) ?? undefined,
  };
}

export async function natfrpUser(): Promise<NatfrpUser> {
  return toUser(await apiJson<unknown>("/user/info"));
}

// ---------- 隧道与节点 ----------

export async function natfrpTunnels(): Promise<NatfrpTunnel[]> {
  const raw = await apiJson<unknown>("/tunnels");
  return jsonArray(raw)
    .map(jsonObject)
    .map((tunnel) => ({
      id: jsonNumber(tunnel.id),
      name: jsonString(tunnel.name),
      type: jsonString(tunnel.type),
      node: jsonNumber(tunnel.node),
      localIp: jsonString(tunnel.local_ip),
      localPort: jsonNumber(tunnel.local_port),
      remote: jsonString(tunnel.remote) || undefined,
      online: tunnel.online === true,
    }))
    .filter((tunnel) => tunnel.id > 0);
}

export async function natfrpNodes(): Promise<{ id: number; name: string; publicGameAllowed: boolean }[]> {
  const raw = await apiJson<unknown>("/nodes");
  const nodes: { id: number; name: string; publicGameAllowed: boolean }[] = [];
  for (const [key, value] of Object.entries(jsonObject(raw))) {
    const node = jsonObject(value);
    const name = jsonString(node.name) || `#${key}`;
    const flag = jsonNumber(node.flag);
    nodes.push({
      id: jsonNumber(key),
      name,
      publicGameAllowed: (flag & PUBLIC_GAME_FLAG) !== 0 || name.includes("多线"),
    });
  }
  return nodes.sort((a, b) => a.id - b.id);
}

export async function natfrpCreate(name: string, node: number, localPort: number): Promise<{ id: number; name: string }> {
  const tunnelName = jsonString(name);
  if (!tunnelName) throw new Error(mt("net.natfrp.tunnelNameRequired"));
  const nodeId = Number(node);
  if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error(mt("net.natfrp.badNodeId", { id: String(node) }));
  const port = Number(localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(mt("net.natfrp.badPort", { port: String(localPort) }));

  const raw = await apiJson<unknown>("/tunnels", {
    method: "POST",
    form: { name: tunnelName, type: "tcp", node: nodeId, local_ip: DEFAULT_LOCAL_IP, local_port: port },
  });
  const created = jsonObject(raw);
  const id = jsonNumber(created.id);
  if (!id) throw new Error(mt("net.natfrp.noTunnelId"));
  const warning = jsonString(created.important_warning_for_ai);
  if (warning) log.warn(warning);
  return { id, name: jsonString(created.name) || tunnelName };
}

// ---------- frpc 客户端 ----------

interface FrpcClient {
  version: string;
  url: string;
  hash: string;
  size: number;
}

let clientCache: FrpcClient | null = null;

/** /system/clients 是公开接口（免鉴权），取 frpc 的版本、下载地址、哈希与体积。 */
async function frpcClient(): Promise<FrpcClient> {
  const raw = await apiJson<unknown>("/system/clients", { auth: false });
  const frpc = jsonObject(jsonObject(raw).frpc);
  const win = jsonObject(jsonObject(frpc.archs).windows_amd64);
  const url = jsonString(win.url);
  if (!url) throw new Error(mt("net.natfrp.noFrpcUrl"));
  // 下载地址里带着归档的真实版本号（实测比 frpc.ver 新一版），取配置时以它为准
  const version = /\/frpc\/([^/]+)\//.exec(url)?.[1] ?? jsonString(frpc.ver);
  return { version, url, hash: jsonString(win.hash).toLowerCase(), size: jsonNumber(win.size) };
}

/**
 * 确保 <NaiWa>/tools/frpc.exe 就绪：已存在且体积一致（且哈希匹配）就跳过，否则重新下载并校验。
 */
export async function ensureFrpc(): Promise<string> {
  const client = clientCache ?? (clientCache = await frpcClient());
  const dest = frpcExePath();
  state.frpcVersion = client.version;
  const algorithm = hashAlgorithm(client.hash);
  const expectedSize = client.size > 0 ? client.size : null;

  const existing = await sizeOf(dest);
  if (existing !== null && (expectedSize === null || existing === expectedSize)) {
    const actual = algorithm ? await hashOfFile(dest, algorithm) : "";
    if (!algorithm || actual === client.hash) {
      log.info(`frpc 已就绪（${client.version}，${existing} 字节${algorithm ? `，${algorithm} 校验通过` : "，无哈希跳过校验"}）`);
      return dest;
    }
    log.warn(`frpc 哈希不匹配（期望 ${client.hash}，实际 ${actual}），重新下载`);
    await rm(dest, { force: true });
  } else if (existing !== null) {
    log.warn(`frpc 体积不匹配（期望 ${expectedSize}，实际 ${existing}），重新下载`);
    await rm(dest, { force: true });
  }

  await mkdir(toolsDir(), { recursive: true });
  const startedAt = Date.now();
  await downloadFile(client.url, dest, { connections: 4, label: mt("net.natfrp.downloadLabel") });

  const bytes = await sizeOf(dest);
  if (bytes === null) throw new Error(mt("net.natfrp.frpcDownloadFailed"));
  if (expectedSize !== null && bytes !== expectedSize) {
    await rm(dest, { force: true });
    throw new Error(mt("net.natfrp.frpcIncomplete", { expected: expectedSize, actual: bytes }));
  }
  if (algorithm) {
    const actual = await hashOfFile(dest, algorithm);
    if (actual !== client.hash) {
      await rm(dest, { force: true });
      throw new Error(mt("net.natfrp.frpcChecksum", { algorithm, expected: client.hash, actual }));
    }
  }
  log.info(
    `frpc ${client.version} 下载完成：${bytes} 字节，用时 ${Date.now() - startedAt}ms，${algorithm ? `${algorithm} 校验通过` : "无哈希跳过校验"}`,
  );
  return dest;
}

// ---------- frpc 进程 ----------

function trimLog(keep: number): void {
  if (state.log.length > keep) state.log = state.log.slice(state.log.length - keep);
}

function pushLine(line: string): void {
  const text = line.replace(/\s+$/, "");
  if (!text) return;
  state.log.push(text);
  trimLog(MAX_LOG_LINES);
}

const HOST_PORT = /\b([A-Za-z0-9][A-Za-z0-9.-]*):(\d{2,5})\b/g;
/** 公网地址的典型主机名：SakuraFrp 下发的节点域名形如 cn-1.frp.one / xxx.natfrp.io。 */
const PUBLIC_HOST = /frp\.one|natfrp|globalslb/i;
/** frpc 日志里带地址的关键词（部分版本把远程地址单独打一行）。 */
const ADDRESS_HINT = /remote[_\s]?addr|远程地址|公网|address/i;

/** 从 frpc 输出里解析公网地址；拿不到返回 null（时间戳里的 12:00:00 因主机名不含 . 被排除）。 */
export function parseFrpcAddress(line: string): string | null {
  const hinted = ADDRESS_HINT.test(line);
  for (const match of line.matchAll(HOST_PORT)) {
    const host = match[1];
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!host.includes(".")) continue;
    if (PUBLIC_HOST.test(host) || hinted) return `${host}:${port}`;
  }
  return null;
}

function handleOutputLine(line: string): void {
  pushLine(line);
  const found = parseFrpcAddress(line);
  if (found && found !== state.address) {
    state.address = found;
    pushLine(mt("net.natfrp.publicAddr", { addr: found }));
  }
}

function pipeLines(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    rest += chunk;
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? "";
    for (const part of parts) handleOutputLine(part);
    // 没有换行的巨量输出不能无限攒在内存里
    if (rest.length > 4096) {
      handleOutputLine(rest);
      rest = "";
    }
  });
  stream.on("end", () => {
    if (rest.trim()) handleOutputLine(rest);
    rest = "";
  });
}

/** 进程真的退出后清理状态；已被新的启动覆盖（隧道 id 变了）就不动。 */
function releaseState(tunnelId: number): void {
  if (state.tunnelId !== tunnelId) return;
  state.child = null;
  state.tunnelId = null;
  state.address = "";
}

function attachProcess(tunnelId: number, child: ChildProcess): void {
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  child.on("error", (err) => {
    pushLine(mt("net.natfrp.frpcStartFailed", { error: err.message }));
    log.error(`frpc 启动失败（隧道 ${tunnelId}）：${err.message}`);
    releaseState(tunnelId);
  });
  child.on("exit", (code, signal) => {
    const reason = signal ? `signal=${signal}` : `code=${code}`;
    pushLine(mt("net.natfrp.frpcExited", { reason }));
    log.info(`frpc 已退出（隧道 ${tunnelId}，${reason}）`);
    releaseState(tunnelId);
  });
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/** frpc 从 0.52 起才支持 TOML 配置；SakuraFrp 现在分发的 0.51.0-sakura-15 实测只吃 ini。 */
function frpcSupportsToml(version: string): boolean {
  const matched = /(\d+)\.(\d+)/.exec(version);
  if (!matched) return true;
  return Number(matched[1]) > 0 || Number(matched[2]) >= 52;
}

/** frpc 靠扩展名选解析器：新格式顶层就是 serverAddr = "…"，旧格式首段是 [common]。 */
function configExtension(text: string, contentType: string, version: string): ".toml" | ".ini" {
  if (/toml/i.test(contentType)) return ".toml";
  if (/ini/i.test(contentType)) return ".ini";
  if (/^\s*serverAddr\s*=/m.test(text)) return ".toml";
  if (/^\s*\[common\]/m.test(text)) return ".ini";
  // 认不出内容时按客户端能力兜底，别把一个 ini-only 的 frpc 喂 toml
  return frpcSupportsToml(version) ? ".toml" : ".ini";
}

async function spawnFrpc(tunnelId: number, configText: string, contentType = ""): Promise<NatfrpStatus> {
  const exe = await ensureFrpc();
  const ext = configExtension(configText, contentType, state.frpcVersion);
  if (ext === ".toml" && !frpcSupportsToml(state.frpcVersion)) {
    throw new Error(mt("net.natfrp.tomlUnsupported", { version: state.frpcVersion || mt("core.unknownVersion") }));
  }
  const dir = netDir();
  const file = join(dir, `frpc-${tunnelId}${ext}`);
  await mkdir(dirname(file), { recursive: true });
  // 配置里含访问密钥，只给当前用户读
  await writeFile(file, configText, { encoding: "utf8", mode: 0o600 });

  const child = spawn(exe, ["-c", file], { cwd: dir, windowsHide: true });
  state.child = child;
  state.tunnelId = tunnelId;
  state.address = "";
  pushLine(mt("net.natfrp.frpcStart", { cmd: exe + " -c " + file }));
  attachProcess(tunnelId, child);
  return natfrpStatus();
}

/**
 * 启动隧道。opts.configText 是自检用的注入口：给了就不去请求 /tunnel/config，
 * 便于在没有真实访问密钥时验证「写配置 → 起进程 → 收日志 → 停进程」这条链路。
 */
export async function natfrpStart(tunnelId: number, opts: { configText?: string } = {}): Promise<NatfrpStatus> {
  const id = Number(tunnelId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(mt("net.natfrp.badTunnelId", { id: String(tunnelId) }));
  if (state.child) await natfrpStop();

  const stub = opts.configText ?? "";
  if (stub.trim()) return await spawnFrpc(id, stub);

  const client = clientCache ?? (clientCache = await frpcClient());
  state.frpcVersion = client.version;
  const config = await apiText("/tunnel/config", {
    method: "POST",
    form: { query: String(id), frpc: client.version },
  });
  if (!config.text.trim()) throw new Error(mt("net.natfrp.noConfig"));
  return await spawnFrpc(id, config.text, config.contentType);
}

export async function natfrpStop(): Promise<NatfrpStatus> {
  const child = state.child;
  const tunnelId = state.tunnelId;
  if (!child) {
    state.tunnelId = null;
    state.address = "";
    trimLog(KEEP_LOG_LINES);
    return natfrpStatus();
  }

  const pid = child.pid;
  pushLine(mt("net.natfrp.frpcStop", { id: tunnelId ?? "?" }));
  let exited = false;
  try {
    child.kill();
  } catch {
    /* 已经退出 */
  }
  exited = await waitExit(child, KILL_GRACE_MS);
  if (!exited && process.platform === "win32" && pid) {
    // SIGTERM 在 Windows 上只是终止请求，卡住时用 taskkill 连子进程树一起收掉
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    exited = await waitExit(child, 1000);
  } else if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退出 */
    }
    exited = await waitExit(child, 1000);
  }

  pushLine(exited ? mt("net.natfrp.frpcStopped") : mt("net.natfrp.frpcStopTimeout"));
  state.child = null;
  state.tunnelId = null;
  state.address = "";
  trimLog(KEEP_LOG_LINES);
  log.info(`已停止樱花穿透隧道 ${tunnelId ?? "?"}`);
  return natfrpStatus();
}

export function natfrpStatus(): NatfrpStatus {
  let frpcReady = false;
  try {
    frpcReady = existsSync(frpcExePath());
  } catch {
    /* paths 未初始化（启动极早期） */
  }
  return {
    running: state.child !== null,
    tunnelId: state.tunnelId ?? undefined,
    address: state.address || undefined,
    log: [...state.log],
    frpcReady,
  };
}
