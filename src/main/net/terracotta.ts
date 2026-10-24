import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { app } from "electron";

import type { TeraPlayer, TeraState, TeraStatus } from "../../shared/ipc";
import { downloadFile } from "../core/http";
import { DICT, mt } from "../core/i18n";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";

const log = logger("terracotta");

/**
 * 主进程文案：core/i18n.ts 不在本功能的可改范围内，但 mt() 是唯一出口，
 * 所以把陶瓦自己的条目补进它的字典（与 renderer 的 i18n-extra.ts 是同一个思路）。
 */
const TEXT: Record<string, { "zh-CN": string; "en-US": string; "ja-JP": string }> = {
  "net.tera.windowsOnly": {
    "zh-CN": "陶瓦联机目前只支持 Windows（按官方 Windows x64 包分发）",
    "en-US": "The Terracotta integration currently supports Windows only (official Windows x64 build)",
    "ja-JP": "陶瓦接続は現在 Windows のみ対応です（公式 Windows x64 版を配布します）",
  },
  "net.tera.downloadLabel": {
    "zh-CN": "陶瓦联机",
    "en-US": "Terracotta",
    "ja-JP": "陶瓦接続",
  },
  "net.tera.downloading": {
    "zh-CN": "正在下载陶瓦联机（{size}）…",
    "en-US": "Downloading Terracotta ({size})…",
    "ja-JP": "陶瓦接続をダウンロードしています（{size}）…",
  },
  "net.tera.downloadFailed": {
    "zh-CN": "下载陶瓦联机失败（已试过 {count} 个下载源）：{error}",
    "en-US": "Could not download Terracotta (tried {count} sources): {error}",
    "ja-JP": "陶瓦接続のダウンロードに失敗しました（{count} 個の配布元を試行）：{error}",
  },
  "net.tera.archiveSize": {
    "zh-CN": "陶瓦压缩包体积不对（期望 {expected} 字节，实际 {actual} 字节），已删除重下",
    "en-US": "The Terracotta archive has the wrong size (expected {expected} bytes, got {actual}); deleted it",
    "ja-JP": "陶瓦アーカイブのサイズが不正です（期待 {expected} バイト、実際 {actual} バイト）。削除しました",
  },
  "net.tera.archiveChecksum": {
    "zh-CN": "陶瓦压缩包校验失败（期望 sha256 {expected}，实际 {actual}）",
    "en-US": "Terracotta archive checksum mismatch (expected sha256 {expected}, got {actual})",
    "ja-JP": "陶瓦アーカイブのチェックサムが一致しません（期待 sha256 {expected}、実際 {actual}）",
  },
  "net.tera.archiveEntries": {
    "zh-CN": "陶瓦压缩包里没有找到 {name}，官方包结构可能变了",
    "en-US": "The Terracotta archive does not contain {name}; the official layout may have changed",
    "ja-JP": "陶瓦アーカイブに {name} が見つかりません。公式の構成が変わった可能性があります",
  },
  "net.tera.exeChecksum": {
    "zh-CN": "terracotta.exe 校验失败（期望 sha256 {expected}，实际 {actual}）",
    "en-US": "terracotta.exe checksum mismatch (expected sha256 {expected}, got {actual})",
    "ja-JP": "terracotta.exe のチェックサムが一致しません（期待 sha256 {expected}、実際 {actual}）",
  },
  "net.tera.dllChecksum": {
    "zh-CN": "VCRUNTIME140.DLL 校验失败（期望 sha256 {expected}，实际 {actual}）",
    "en-US": "VCRUNTIME140.DLL checksum mismatch (expected sha256 {expected}, got {actual})",
    "ja-JP": "VCRUNTIME140.DLL のチェックサムが一致しません（期待 sha256 {expected}、実際 {actual}）",
  },
  "net.tera.portTimeout": {
    "zh-CN": "陶瓦启动后 {ms}ms 内没有写出端口文件，可能是杀软拦截或 VCRUNTIME140 缺失",
    "en-US": "Terracotta wrote no port file within {ms}ms; antivirus blocking or a missing VCRUNTIME140 is the usual cause",
    "ja-JP": "陶瓦は {ms}ms 以内にポートファイルを書き出しませんでした。セキュリティソフトの遮断か VCRUNTIME140 の欠如が原因です",
  },
  "net.tera.metaTimeout": {
    "zh-CN": "陶瓦已经拿到端口（{port}）但 HTTP 接口一直没响应：{error}",
    "en-US": "Terracotta published a port ({port}) but its HTTP API never answered: {error}",
    "ja-JP": "陶瓦はポート（{port}）を公開しましたが、HTTP API が応答しません：{error}",
  },
  "net.tera.notWaiting": {
    "zh-CN": "陶瓦当前状态是「{state}」，请先返回或停止后再操作",
    "en-US": "Terracotta is in state {state}; press Back or Stop first",
    "ja-JP": "陶瓦の現在の状態は「{state}」です。先に戻るか停止してください",
  },
  "net.tera.badRoom": {
    "zh-CN": "邀请码格式不对：应为 U/XXXX-XXXX-XXXX-XXXX（16 位数字与字母，不含 I 和 O）",
    "en-US": "That invite code is malformed: expected U/XXXX-XXXX-XXXX-XXXX (16 digits or letters, no I or O)",
    "ja-JP": "招待コードの形式が不正です：U/XXXX-XXXX-XXXX-XXXX（16 文字、I と O を除く）",
  },
  "net.tera.requestFailed": {
    "zh-CN": "陶瓦接口请求失败：{error}",
    "en-US": "Terracotta API request failed: {error}",
    "ja-JP": "陶瓦 API のリクエストに失敗しました：{error}",
  },
  "net.tera.secondary": {
    "zh-CN": "检测到已有陶瓦实例在运行，已复用它的端口（{port}）；停止只会断开连接，不会结束该实例",
    "en-US": "Another Terracotta instance is already running; reusing its port ({port}). Stopping only detaches, that instance keeps running",
    "ja-JP": "既に陶瓦が起動しているため、そのポート（{port}）を再利用します。停止は接続を切るだけで、そのインスタンスは終了しません",
  },
  "net.tera.stopDetached": {
    "zh-CN": "已断开与正在运行的陶瓦的连接（该实例由外部启动，未结束）",
    "en-US": "Detached from the running Terracotta instance (started outside the launcher, left running)",
    "ja-JP": "起動中の陶瓦から切断しました（外部で起動されたインスタンスのため終了していません）",
  },
  "net.tera.panic": {
    "zh-CN": "已请求陶瓦退出（连接被切断属正常）",
    "en-US": "Asked Terracotta to exit (a dropped connection is expected)",
    "ja-JP": "陶瓦に終了を要求しました（接続断は正常です）",
  },
  "net.tera.killed": {
    "zh-CN": "已强制结束残留进程：{pids}",
    "en-US": "Force-terminated leftover processes: {pids}",
    "ja-JP": "残っていたプロセスを強制終了しました：{pids}",
  },
  "net.tera.stopped": {
    "zh-CN": "陶瓦已停止",
    "en-US": "Terracotta stopped",
    "ja-JP": "陶瓦を停止しました",
  },
  "net.tera.stateRecovered": {
    "zh-CN": "已把陶瓦复位到 waiting",
    "en-US": "Terracotta reset to waiting",
    "ja-JP": "陶瓦を waiting に戻しました",
  },
};
for (const [key, value] of Object.entries(TEXT)) DICT[key] = value;

/** 官方发布：Windows x64 的 pkg.tar.gz（内含 terracotta.exe 与 VCRUNTIME140.DLL）。 */
const RELEASE = "v0.4.2";
const ARCHIVE_NAME = "terracotta-0.4.2-windows-x86_64-pkg.tar.gz";
const ARCHIVE_SIZE = 8135914;
const ARCHIVE_SHA256 = "07ebe139e3ca5f74576e58b1a96efe59abdfbe148d3f1a49bfdca8b6f70745f0";
/** 解包后两个文件的哈希：体积与哈希都对齐官方包，防镜像投毒与半截文件。 */
const EXE_SHA256 = "74c10568a7fea9c1d38cf8d2d4ca90baf1517f8e5a26c63d3349db70bc449796";
const DLL_SHA256 = "475ab98b7722e965bd38c8fa6ed23502309582ccf294ff1061cb290c7988f0d1";
const EXE_NAME = "terracotta.exe";
const DLL_NAME = "VCRUNTIME140.DLL";
/**
 * 下载源：GitHub 官方 Release 优先，Gitee 镜像按同一 tag/资产名兜底。
 * 内容一律按 sha256 校验，镜像给错文件只会被拒绝，不会被执行。
 */
const MIRRORS = [
  "https://github.com/burningtnt/Terracotta/releases/download/" + RELEASE + "/" + ARCHIVE_NAME,
  "https://gitee.com/burningtnt/Terracotta/releases/download/" + RELEASE + "/" + ARCHIVE_NAME,
];
/**
 * 公共节点：与官方 fetch_public_nodes 的内置列表一致（见 docs/TERRACOTTA-FEASIBILITY.md §5）。
 * 后续要开设置项时把这里换成配置读取即可。
 */
const PUBLIC_NODES = [
  "tcp://public.easytier.top:11010",
  "tcp://public2.easytier.cn:54321",
  "https://etnode.zkitefly.eu.org/node1",
  "https://etnode.zkitefly.eu.org/node2",
];

/** /state 轮询间隔：官方推荐 500ms；index 单调递增且会跳号，按最大 index 去重。 */
const STATE_POLL_MS = 500;
/** --hmcl 的父进程最多等 8s 端口文件，这里留余量。 */
const PORT_WAIT_MS = 9000;
const PORT_POLL_MS = 100;
const META_WAIT_MS = 5000;
const HTTP_TIMEOUT_MS = 4000;
/** /panic 之后等端口关闭的时间，再按端口反查 PID 兜底。 */
const EXIT_GRACE_MS = 2000;
const MAX_LOG_LINES = 200;
/** %TEMP%\terracotta\<YYYY-MM-DD-HH-MM-SS>-<pid> 超过一天才清（当天可能在跑）。 */
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface TeraRuntime {
  /** --hmcl 的父进程（写完端口文件就退出），只用于收尾。 */
  child: ChildProcess | null;
  port: number | null;
  secondary: boolean;
  state: TeraState;
  index: number;
  room: string;
  url: string;
  difficulty: string;
  players: TeraPlayer[];
  exceptionType: number | null;
  version: string;
  easytierVersion: string;
  problem: string;
  timer: NodeJS.Timeout | null;
  /** 启动/停止串行化：连点两次不要拉出两个 worker。 */
  pending: Promise<unknown> | null;
  log: string[];
}

const state: TeraRuntime = {
  child: null,
  port: null,
  secondary: false,
  state: "waiting",
  index: -1,
  room: "",
  url: "",
  difficulty: "",
  players: [],
  exceptionType: null,
  version: "",
  easytierVersion: "",
  problem: "",
  timer: null,
  pending: null,
  log: [],
};

// ---------- 基础工具 ----------

function toolsDir(): string {
  return join(getPaths().dataRoot, "tools", "terracotta");
}

function exePath(): string {
  return join(toolsDir(), EXE_NAME);
}

function dllPath(): string {
  return join(toolsDir(), DLL_NAME);
}

function archivePath(): string {
  return join(toolsDir(), ARCHIVE_NAME);
}

/** 端口文件放 Electron 的 userData，避免和用户自己 %TEMP% 里的端口文件撞名。 */
function portFile(pid: number): string {
  return join(app.getPath("userData"), "terracotta", "port-" + pid + ".json");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pushLine(line: string): void {
  const text = line.replace(/\s+$/, "");
  if (!text) return;
  state.log.push(text);
  if (state.log.length > MAX_LOG_LINES) state.log = state.log.slice(state.log.length - MAX_LOG_LINES);
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    return await sha256Of(path);
  } catch {
    return null;
  }
}

/** tasklist 查同名进程：启动前判断是否要变成 secondary，停止后确认没有残留。 */
function pidsOf(image: string): number[] {
  if (process.platform !== "win32") return [];
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + image, "/FO", "CSV", "/NH"], {
    windowsHide: true,
    encoding: "utf8",
  });
  const text = String(out.stdout ?? "");
  if (!text || /No tasks are running|INFO:/i.test(text)) return [];
  const pids: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const matched = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (matched && Number(matched[2]) > 0) pids.push(Number(matched[2]));
  }
  return pids;
}

/** netstat 反查监听某端口的进程：陶瓦真正的 worker 是 --hmcl 派生的分离进程，child.kill() 打不到它。 */
function portPids(port: number): number[] {
  if (process.platform !== "win32") return [];
  const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, encoding: "utf8" });
  const text = String(out.stdout ?? "");
  const suffix = ":" + port;
  const pids = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (!(cols[1] ?? "").endsWith(suffix)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function killTree(pid: number): void {
  if (process.platform !== "win32" || pid <= 0) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}

/** 只清 %TEMP%\terracotta 下「一天前的 <时间>-<pid> 目录」，machine-id 与锁文件不碰。 */
async function cleanupTempDirs(): Promise<void> {
  const root = join(tmpdir(), "terracotta");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const matched = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-\d+$/.exec(entry.name);
    if (!matched) continue;
    const stamp = matched[1] + "-" + matched[2] + "-" + matched[3] + "T" + matched[4] + ":" + matched[5] + ":" + matched[6];
    const created = Date.parse(stamp);
    if (!Number.isFinite(created) || now - created < TEMP_MAX_AGE_MS) continue;
    await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined);
    log.info("已清理过期的陶瓦临时目录：" + entry.name);
  }
}

// ---------- 二进制：下载 + 解包 + 校验 ----------

interface TarEntry {
  name: string;
  data: Buffer;
}

/** 最小 tar 解析（ustar）：只认普通文件，够解官方 pkg.tar.gz。 */
function tarEntries(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "").trim();
    if (!name) break;
    const size = parseInt(header.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim(), 8) || 0;
    const type = header[156];
    const start = offset + 512;
    if (type === 0x30 || type === 0) entries.push({ name, data: buffer.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function isReady(): Promise<boolean> {
  if ((await fileSha256(exePath())) !== EXE_SHA256) return false;
  return (await fileSha256(dllPath())) === DLL_SHA256;
}

/**
 * 确保 <dataRoot>/tools/terracotta 下有官方 terracotta.exe 与 VCRUNTIME140.DLL。
 * 已存在且哈希对得上直接复用；否则按 MIRRORS 顺序下载 pkg.tar.gz、校验、解包。
 */
export async function ensureTerracotta(): Promise<string> {
  if (process.platform !== "win32") throw new Error(mt("net.tera.windowsOnly"));
  const exe = exePath();
  if (await isReady()) return exe;

  await mkdir(toolsDir(), { recursive: true });
  const archive = archivePath();
  const label = mt("net.tera.downloadLabel");
  let lastError = "";

  for (const url of MIRRORS) {
    try {
      pushLine(mt("net.tera.downloading", { size: "9.4MB" }));
      log.info("下载陶瓦联机：" + url);
      await rm(archive, { force: true });
      await downloadFile(url, archive, { connections: 4, label });
      const downloaded = await readFile(archive);
      if (downloaded.byteLength !== ARCHIVE_SIZE) {
        await rm(archive, { force: true });
        throw new Error(mt("net.tera.archiveSize", { expected: ARCHIVE_SIZE, actual: downloaded.byteLength }));
      }
      const actualSha = await sha256Of(archive);
      if (actualSha !== ARCHIVE_SHA256) {
        await rm(archive, { force: true });
        throw new Error(mt("net.tera.archiveChecksum", { expected: ARCHIVE_SHA256, actual: actualSha }));
      }

      const entries = tarEntries(gunzipSync(downloaded));
      const exeEntry = entries.find((item) => item.name.toLowerCase().endsWith(".exe"));
      const dllEntry = entries.find((item) => item.name.toUpperCase().endsWith(DLL_NAME));
      if (!exeEntry) throw new Error(mt("net.tera.archiveEntries", { name: EXE_NAME }));
      if (!dllEntry) throw new Error(mt("net.tera.archiveEntries", { name: DLL_NAME }));
      const exeSha = createHash("sha256").update(exeEntry.data).digest("hex");
      if (exeSha !== EXE_SHA256) throw new Error(mt("net.tera.exeChecksum", { expected: EXE_SHA256, actual: exeSha }));
      const dllSha = createHash("sha256").update(dllEntry.data).digest("hex");
      if (dllSha !== DLL_SHA256) throw new Error(mt("net.tera.dllChecksum", { expected: DLL_SHA256, actual: dllSha }));

      await writeFile(exe, exeEntry.data);
      await writeFile(dllPath(), dllEntry.data);
      await rm(archive, { force: true });
      log.info("陶瓦联机就绪：" + exeEntry.data.length + " 字节（sha256 校验通过）");
      return exe;
    } catch (err) {
      lastError = errorMessage(err);
      log.warn("下载源失败（" + url + "）：" + lastError);
    }
  }
  throw new Error(mt("net.tera.downloadFailed", { count: MIRRORS.length, error: lastError }));
}

// ---------- 本地 HTTP（只监听 127.0.0.1、无鉴权、无 CORS，必须在主进程请求） ----------

function baseUrl(): string {
  return "http://127.0.0.1:" + String(state.port ?? 0);
}

async function request(route: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(baseUrl() + route, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(route: string): Promise<Record<string, unknown>> {
  const res = await request(route);
  if (!res.ok) throw new Error(route + " -> HTTP " + res.status);
  const json: unknown = await res.json();
  return typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

function jsonString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** profiles 允许缺字段：machine_id/厂商名按空串兜底，名字必须有。 */
function toPlayers(raw: unknown): TeraPlayer[] {
  if (!Array.isArray(raw)) return [];
  const players: TeraPlayer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const profile = item as Record<string, unknown>;
    const name = jsonString(profile.name);
    if (!name) continue;
    players.push({
      machineId: jsonString(profile.machine_id),
      name,
      vendor: jsonString(profile.vendor),
      kind: jsonString(profile.kind) || "UNKNOWN",
    });
  }
  return players;
}

/** 房主/房客的公共节点参数：官方把 public_nodes 当重复键解析成 Vec<String>。 */
function publicNodeQuery(): string {
  return PUBLIC_NODES.map((node) => "&public_nodes=" + encodeURIComponent(node)).join("");
}

// ---------- 状态机轮询 ----------

function applyState(json: Record<string, unknown>): void {
  const index = jsonNumber(json.index, -1);
  // index 单调递增且会跳号：小于等于当前快照的一律是过期响应
  if (index <= state.index) return;
  const next = jsonString(json.state);
  if (!next) return;

  state.index = index;
  state.state = next as TeraState;
  state.room = jsonString(json.room);
  state.url = jsonString(json.url);
  state.difficulty = jsonString(json.difficulty);
  state.players = toPlayers(json.profiles);
  state.exceptionType = next === "exception" ? jsonNumber(json.type, -1) : null;
  log.info("状态 " + next + "（index " + index + "）" + (state.room ? " room=" + state.room : ""));
}

function stopPolling(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

function startPolling(): void {
  stopPolling();
  state.timer = setInterval(() => {
    void requestJson("/state").then(
      (json) => {
        state.problem = "";
        applyState(json);
      },
      (err: unknown) => {
        // 单次失败不代表死了（/panic 之后必然失败），留给下一次
        state.problem = errorMessage(err);
      },
    );
  }, STATE_POLL_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等 --hmcl 写出端口文件（父进程自己最多等 8s）。 */
function waitPortFile(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const timer = setInterval(() => {
      waited += PORT_POLL_MS;
      void readFile(file, "utf8").then(
        (text) => {
          clearInterval(timer);
          try {
            const port = jsonNumber((JSON.parse(text) as { port?: unknown }).port);
            if (!port) throw new Error("port 字段为空");
            resolve(port);
          } catch (err) {
            reject(new Error(mt("net.tera.portTimeout", { ms: PORT_WAIT_MS }) + " · " + errorMessage(err)));
          }
        },
        () => {
          if (waited >= PORT_WAIT_MS) {
            clearInterval(timer);
            reject(new Error(mt("net.tera.portTimeout", { ms: PORT_WAIT_MS })));
          }
        },
      );
    }, PORT_POLL_MS);
  });
}

/** spawn --hmcl <portFile> → 等端口 → 重试 /meta 直到 200。 */
async function launch(): Promise<void> {
  if (state.port !== null) return;
  const exe = await ensureTerracotta();
  void cleanupTempDirs();

  // spawn 之前就存在的 terracotta.exe 说明全局单实例锁被别人持有：我们会变成 secondary 复用它的端口
  const existing = pidsOf(EXE_NAME).length;
  const dir = join(app.getPath("userData"), "terracotta");
  const file = portFile(process.pid);
  await mkdir(dir, { recursive: true });
  // 先删端口文件：残留的 {"port":N} 会被瞬间读到，连到一个已经死掉的端口
  await rm(file, { force: true });

  const child = spawn(exe, ["--hmcl", file], { cwd: toolsDir(), windowsHide: true, stdio: "ignore" });
  state.child = child;
  pushLine("spawn " + exe + " --hmcl " + file);
  child.on("exit", (code) => pushLine("--hmcl 父进程退出（code=" + String(code) + "）"));

  const started = Date.now();
  let port = 0;
  try {
    port = await waitPortFile(file);
  } catch (err) {
    state.problem = errorMessage(err);
    throw err;
  }

  state.port = port;
  state.secondary = existing > 0;
  state.index = -1;
  state.state = "waiting";
  state.room = "";
  state.url = "";
  state.difficulty = "";
  state.players = [];
  state.exceptionType = null;
  pushLine("端口 " + port + "（" + (Date.now() - started) + "ms）");
  if (state.secondary) pushLine(mt("net.tera.secondary", { port }));

  const deadline = Date.now() + META_WAIT_MS;
  for (;;) {
    try {
      const meta = await requestJson("/meta");
      state.version = jsonString(meta.version);
      state.easytierVersion = jsonString(meta.easytier_version);
      state.problem = "";
      pushLine("/meta version=" + state.version + " easytier=" + state.easytierVersion);
      break;
    } catch (err) {
      if (Date.now() >= deadline) {
        state.problem = mt("net.tera.metaTimeout", { port, error: errorMessage(err) });
        throw new Error(state.problem);
      }
      await sleep(100);
    }
  }
  startPolling();
}

/** 同一时刻只跑一个启动/停止流程。 */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const previous = state.pending ?? Promise.resolve();
  const next = previous.then(work, work);
  state.pending = next.catch(() => undefined);
  return next;
}

function requireWaiting(): void {
  if (state.state !== "waiting") throw new Error(mt("net.tera.notWaiting", { state: state.state }));
}

// ---------- 对外接口 ----------

/** 房主：waiting → host-scanning；用户在游戏里「对局域网开放」后自动进 host-ok。 */
export async function terracottaHost(player?: string): Promise<TeraStatus> {
  return exclusive(async () => {
    await launch();
    requireWaiting();
    const query = "?player=" + encodeURIComponent(player ?? "") + publicNodeQuery();
    try {
      const res = await request("/state/scanning" + query);
      if (!res.ok) throw new Error("/state/scanning -> HTTP " + res.status);
      pushLine("已请求开始扫描本机局域网端口");
    } catch (err) {
      state.problem = mt("net.tera.requestFailed", { error: errorMessage(err) });
      throw new Error(state.problem);
    }
    return terracottaStatus();
  });
}

/** 加入方：输入宽松邀请码，自动补 U/ 与短横线。 */
export async function terracottaJoin(room: string, player?: string): Promise<TeraStatus> {
  return exclusive(async () => {
    const code = normalizeRoom(room);
    await launch();
    requireWaiting();
    const query = "?room=" + encodeURIComponent(code) + "&player=" + encodeURIComponent(player ?? "") + publicNodeQuery();
    try {
      const res = await request("/state/guesting" + query);
      if (!res.ok) throw new Error("/state/guesting -> HTTP " + res.status);
      pushLine("已请求加入房间 " + code);
    } catch (err) {
      state.problem = mt("net.tera.requestFailed", { error: errorMessage(err) });
      throw new Error(state.problem);
    }
    return terracottaStatus();
  });
}

/** 复位回 waiting：exception 之后的唯一出口（陶瓦自己不给别的退路）。 */
export async function terracottaReset(): Promise<TeraStatus> {
  if (state.port === null) return terracottaStatus();
  try {
    const res = await request("/state/ide");
    if (!res.ok) throw new Error("/state/ide -> HTTP " + res.status);
    pushLine(mt("net.tera.stateRecovered"));
  } catch (err) {
    state.problem = mt("net.tera.requestFailed", { error: errorMessage(err) });
  }
  state.state = "waiting";
  state.index = -1;
  state.room = "";
  state.url = "";
  state.difficulty = "";
  state.players = [];
  state.exceptionType = null;
  state.problem = "";
  return terracottaStatus();
}

/**
 * 停止：/panic?peaceful=true（连接被 reset 属成功）→ 等端口关闭 →
 * 按端口反查 PID + taskkill 兜底（陶瓦真正的 worker 是 --hmcl 派生的分离进程，杀父进程没用）。
 * 复用别人的实例时只断开，不结束对方的会话。
 */
export async function terracottaStop(): Promise<TeraStatus> {
  return exclusive(async () => {
    const port = state.port;
    if (port === null) return terracottaStatus();
    stopPolling();

    if (state.secondary) {
      pushLine(mt("net.tera.stopDetached"));
      resetRuntime();
      return terracottaStatus();
    }

    try {
      await request("/panic?peaceful=true", 3000);
    } catch {
      pushLine(mt("net.tera.panic"));
    }

    const deadline = Date.now() + EXIT_GRACE_MS;
    while (Date.now() < deadline && portPids(port).length > 0) await sleep(200);

    const targets = new Set<number>(portPids(port));
    if (state.child?.pid) targets.add(state.child.pid);
    for (const pid of targets) if (pid !== process.pid) killTree(pid);
    // worker 已经收掉，还活着的 easytier-core 一定是孤儿（16MB 的常驻进程不能留）
    for (const pid of pidsOf("easytier-core.exe")) killTree(pid);
    if (targets.size > 0) pushLine(mt("net.tera.killed", { pids: [...targets].join(", ") }));

    const file = portFile(process.pid);
    pushLine(mt("net.tera.stopped"));
    resetRuntime();
    await rm(file, { force: true });
    log.info("陶瓦联机已停止");
    return terracottaStatus();
  });
}

function resetRuntime(): void {
  state.problem = "";
  state.child = null;
  state.port = null;
  state.secondary = false;
  state.state = "waiting";
  state.index = -1;
  state.room = "";
  state.url = "";
  state.difficulty = "";
  state.players = [];
  state.exceptionType = null;
  state.version = "";
  state.easytierVersion = "";
}

/** 陶瓦自己的 application.log 全文（异常排查用）+ 本地启动记录。 */
export async function terracottaLog(): Promise<string> {
  const parts: string[] = [];
  if (state.port !== null) {
    try {
      const res = await request("/log?fetch=true", 6000);
      if (res.ok) parts.push(await res.text());
    } catch (err) {
      parts.push(mt("net.tera.requestFailed", { error: errorMessage(err) }));
    }
  }
  parts.push("--- 启动器记录 ---\n" + state.log.join("\n"));
  return parts.join("\n");
}

/** 宽松解析邀请码：大小写不敏感、I→1 / O→0、可嵌在长文本里、可缺 U/ 前缀。 */
export function normalizeRoom(raw: string): string {
  let text = String(raw ?? "").trim().toUpperCase();
  // 有分隔符就以它为准（"U/xxx"、"U/ xxx"）；没有分隔符时走下面的 17→16 兜底
  const slash = text.indexOf("/");
  if (slash >= 0) text = text.slice(slash + 1);
  let body = text.replace(/[^0-9A-Z]/g, "").replace(/I/g, "1").replace(/O/g, "0");
  // 34 进制本体本身可能以 U 开头，所以只在"多出一个 U"时才把它当前缀去掉
  if (body.length === 17 && body.startsWith("U")) body = body.slice(1);
  if (body.length !== 16) throw new Error(mt("net.tera.badRoom"));
  return "U/" + body.replace(/(.{4})(?=.)/g, "$1-");
}

export function terracottaStatus(): TeraStatus {
  let binaryReady = false;
  try {
    binaryReady = existsSync(exePath()) && existsSync(dllPath());
  } catch {
    /* paths 未初始化（启动极早期） */
  }
  return {
    running: state.port !== null,
    binaryReady,
    version: state.version || undefined,
    easytierVersion: state.easytierVersion || undefined,
    secondary: state.secondary,
    state: state.state,
    index: state.index,
    room: state.room || undefined,
    url: state.url || undefined,
    difficulty: state.difficulty || undefined,
    players: [...state.players],
    exceptionType: state.exceptionType ?? undefined,
    problem: state.problem || undefined,
  };
}
