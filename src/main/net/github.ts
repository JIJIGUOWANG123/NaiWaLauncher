import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { DownloadJob, GithubAcceleratorProbe, Settings, TaskKind, TaskProgress } from "../../shared/types";
import type { GithubDownloadRequest } from "../../shared/ipc";
import type { TaskHandle } from "../core/events";
import { downloadFile } from "../core/http";
import { mt } from "../core/i18n";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { hintNextJob, list as listDownloadJobs, runCancellable, trackProgress, trackResult } from "../downloads/index";

const log = logger("github");

/** 具体节点 id（auto 不是节点，是「按测速挑」的开关）。 */
export type GithubNodeId = Exclude<Settings["githubAccelerator"], "auto">;

export interface GithubNode {
  id: GithubNodeId;
  /** 界面展示名：就是节点域名，用户一眼能对上。 */
  label: string;
  /** 加速前缀，末尾带 /。 */
  base: string;
}

/** 启动器自己的仓库：检查更新要走的 API 路径就是它的 releases/latest。 */
export const LAUNCHER_REPO = "JIJIGUOWANG123/NaiWaLauncher";

/**
 * 七个加速节点，用法是「前缀 + 完整 GitHub 地址」。
 * base 一律过 new URL() 归一化（中文域名会被 Node 转成 punycode），不要手拼字符串后直接 fetch；
 * label 保留可读域名，用户一眼能对上。
 */
export const GITHUB_NODES: GithubNode[] = [
  { id: "ghf", label: "ghf.无名氏.top", base: normalizeBase("https://ghf.无名氏.top/") },
  { id: "padao", label: "gh.padao.fun", base: normalizeBase("https://gh.padao.fun/") },
  { id: "ghfast", label: "ghfast.top", base: normalizeBase("https://ghfast.top/") },
  { id: "cnxiaobai", label: "github.cnxiaobai.com", base: normalizeBase("https://github.cnxiaobai.com/") },
  { id: "tangbai", label: "git.tangbai.cc", base: normalizeBase("https://git.tangbai.cc/") },
  { id: "chenc", label: "github.chenc.dev", base: normalizeBase("https://github.chenc.dev/") },
  { id: "xyz", label: "30006000.xyz", base: normalizeBase("https://30006000.xyz/") },
];

/** 测速目标：一个几十字节的 raw 文件，只等到响应头就够。 */
const PROBE_URL = "https://raw.githubusercontent.com/octocat/Hello-World/master/README";
/**
 * 「能不能代理 api.github.com」的探测目标：必须走 releases/latest 这样的真实 API 路径。
 * 实测节点对 api 的支持是按路径的（rate_limit / users 回 403，releases 却 200），
 * 换个路径会得出错误的可用性结论。
 */
const API_PROBE_URL = "https://api.github.com/repos/" + LAUNCHER_REPO + "/releases/latest";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_ATTEMPTS = 2;
/** 测速结果缓存：auto 解析地址时复用，不必每下一个文件就把整轮请求（7 节点 × 2 次 + 7 个 api 探测）重打一遍。 */
const PROBE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
/** 文件名冲突时最多试到 (999)。 */
const MAX_NAME_TRIES = 1000;

let probeCache: { at: number; list: GithubAcceleratorProbe[] } | null = null;

/** 加速前缀归一化：补末尾 /，中文域名转 punycode。 */
export function normalizeBase(base: string): string {
  return new URL(base.endsWith("/") ? base : `${base}/`).href;
}

/** 拼加速地址：`<base><原始 URL>`，拼完再归一化一次。 */
export function accelerate(base: string, url: string): string {
  return new URL(`${normalizeBase(base)}${url}`).href;
}

/** 只有 github.com / raw.githubusercontent.com 会被加速，其余地址原样返回。 */
export function isGithubUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "github.com" || host === "raw.githubusercontent.com";
  } catch {
    return false;
  }
}

/** 这个节点能不能代理 api.github.com：要拿到 200 的 release JSON 且带 assets（否则给不出资产清单）。 */
async function probeApiProxy(node: GithubNode): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(accelerate(node.base, API_PROBE_URL), {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json, application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = (await res.json().catch(() => null)) as { assets?: unknown } | null;
    return Array.isArray(body?.assets);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 单次探测：拿到响应头就算耗时，正文直接丢弃（测速不该把文件读完）。 */
async function measure(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT },
    });
    const latency = Date.now() - startedAt;
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? latency : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 一个节点测两次取最快：一次抖动不该决定它「不可用」；api 代理能力与测速并行探测。 */
async function probeNode(node: GithubNode): Promise<GithubAcceleratorProbe> {
  const target = accelerate(node.base, PROBE_URL);
  const apiProbe = probeApiProxy(node);
  let best: number | null = null;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const latency = await measure(target);
    if (latency !== null && (best === null || latency < best)) best = latency;
  }
  const apiProxy = await apiProbe;
  return { id: node.id, label: node.label, base: normalizeBase(node.base), latencyMs: best, ok: best !== null, apiProxy };
}

/** 七个节点各测 2 次（5s 超时、并发），返回真实耗时与 api 代理能力；结果同时进缓存供 auto 选节点。 */
export async function probeAccelerators(): Promise<GithubAcceleratorProbe[]> {
  const results = await Promise.all(GITHUB_NODES.map((node) => probeNode(node)));
  probeCache = { at: Date.now(), list: results };
  log.info(
    `节点测速：${results
      .map((item) => `${item.id}=${item.ok ? `${item.latencyMs}ms` : "失败"}${item.apiProxy ? "(api)" : ""}`)
      .join(" ")}`,
  );
  return results;
}

/** 缓存里的测速结果；过期或从没测过就重测一轮。 */
async function cachedProbes(): Promise<GithubAcceleratorProbe[]> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.list;
  return probeAccelerators();
}

/** 同步的缓存快照：固定节点时用它排序兜底，不为排序先等一轮测速。 */
function freshProbes(): GithubAcceleratorProbe[] {
  if (!probeCache || Date.now() - probeCache.at >= PROBE_TTL_MS) return [];
  return probeCache.list;
}

function nodeById(id: GithubNodeId): GithubNode {
  return GITHUB_NODES.find((node) => node.id === id) ?? GITHUB_NODES[0];
}

/** 按实测耗时排序；失败的排最后（sort 稳定，同分保持声明顺序）。 */
function sortByLatency(list: GithubAcceleratorProbe[]): GithubAcceleratorProbe[] {
  const weight = (item: GithubAcceleratorProbe): number =>
    item.ok ? (item.latencyMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  return [...list].sort((a, b) => weight(a) - weight(b));
}

/**
 * 节点优先顺序：
 * - auto：只用测通了的节点，最快的在前；
 * - 固定节点：它排第一，其余按缓存耗时兜底（没缓存就按声明顺序）。
 */
async function orderedNodes(): Promise<GithubNode[]> {
  const selected = getSettings().githubAccelerator;
  if (selected === "auto") {
    const list = await cachedProbes();
    return sortByLatency(list).filter((item) => item.ok).map((item) => nodeById(item.id));
  }
  const primary = nodeById(selected);
  const ranked = sortByLatency(freshProbes())
    .map((item) => nodeById(item.id))
    .filter((node) => node.id !== primary.id);
  const rest = GITHUB_NODES.filter((node) => node.id !== primary.id && !ranked.some((item) => item.id === node.id));
  return [primary, ...ranked, ...rest];
}

/**
 * api 优先顺序：能代理 api.github.com 的节点排前面（组内仍按耗时），
 * 代理不了 api 的节点照样能下载文件，只是不该浪费检查更新的时间在它们身上。
 */
async function orderedNodesForApi(): Promise<GithubNode[]> {
  const base = await orderedNodes();
  const probes = await cachedProbes();
  const canApi = new Set(probes.filter((item) => item.apiProxy === true).map((item) => item.id));
  if (canApi.size === 0) return base;
  return [...base.filter((node) => canApi.has(node.id)), ...base.filter((node) => !canApi.has(node.id))];
}

/** 加速候选地址（不含原地址）：auto 按测速排序，固定节点优先。 */
export async function githubAcceleratedCandidates(url: string, limit?: number): Promise<string[]> {
  if (!isGithubUrl(url)) return [];
  const list = (await orderedNodes()).map((node) => accelerate(node.base, url));
  return typeof limit === "number" ? list.slice(0, Math.max(0, limit)) : list;
}

/**
 * 按「能代理 api 的优先」给出节点前缀。
 * 给 api.github.com 这类不在 isGithubUrl 白名单里的地址用：七个节点本身就是「前缀 + 原地址」，
 * 具体能不能代理某个 github 子域由节点自己决定（实测按路径不同），代理不了的那次只会失败并继续走后面的通道。
 */
export async function githubAcceleratedPrefixes(limit?: number): Promise<string[]> {
  const list = (await orderedNodesForApi()).map((node) => normalizeBase(node.base));
  return typeof limit === "number" ? list.slice(0, Math.max(0, limit)) : list;
}

/** 下载候选：加速地址在前，原地址兜底（节点全挂时直连还能救回来）。 */
export async function githubUrlCandidates(url: string): Promise<string[]> {
  if (!isGithubUrl(url)) return [url];
  const accelerated = await githubAcceleratedCandidates(url);
  return accelerated.length > 0 ? [...accelerated, url] : [url];
}

/** 按设置把 GitHub 地址转成加速地址；非 GitHub 地址原样返回。 */
export async function resolveGithubUrl(url: string): Promise<string> {
  const candidates = await githubUrlCandidates(url);
  return candidates[0] ?? url;
}

/** 保存目录：设置里填了就用它，否则 <启动器根目录>\DL。 */
export function githubDownloadDir(): string {
  const custom = (getSettings().githubDownloadDir ?? "").trim();
  return custom || join(getPaths().root, "DL");
}

/** Windows 文件名里不能出现的字符一律换成下划线。 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
}

/** 从 URL 末段推文件名；推不出来就叫 download.bin。 */
function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return sanitizeFileName(decodeURIComponent(last)) || "download.bin";
  } catch {
    return "download.bin";
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 落盘名去重：同名文件已存在就加 (1)、(2)…
 * 例外是「有续传记录（.part.json）的半成品」——那正是要接着写的目标，不能另起名字，
 * 否则断点续传会变成重新下一份。
 */
async function uniqueTarget(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  let candidate = join(dir, name);
  for (let index = 1; index <= MAX_NAME_TRIES; index += 1) {
    if (!(await exists(candidate))) return candidate;
    if (await exists(`${candidate}.part.json`)) return candidate;
    candidate = join(dir, `${stem} (${index})${ext}`);
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * 把一条 GitHub 直链下载成 DownloadJob（进度自动进「管理」页）。
 * 走 runCancellable 是为了拿到真正绑到这条记录上的取消句柄：
 * 在「管理」页点终止时 downloadFile 会立刻断开连接，而不是只把状态改成已取消。
 */
export async function startGithubDownload(req: GithubDownloadRequest): Promise<DownloadJob> {
  const raw = (req?.url ?? "").trim();
  if (!raw) throw new Error(mt("github.urlRequired"));
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(mt("github.urlInvalid", { url: raw }));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(mt("github.urlScheme", { url: raw }));

  const dir = (req.targetDir ?? "").trim() || githubDownloadDir();
  const wanted = (req.fileName ?? "").trim();
  await mkdir(dir, { recursive: true });
  const name = wanted ? sanitizeFileName(wanted) || fileNameFromUrl(parsed.href) : fileNameFromUrl(parsed.href);
  const dest = await uniqueTarget(dir, name);

  // 加速地址解析失败不影响下载：退回原始地址即可
  let source = parsed.href;
  if (isGithubUrl(parsed.href)) {
    try {
      source = await resolveGithubUrl(parsed.href);
    } catch (err) {
      log.warn(`加速地址解析失败，改用原始地址：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const title = basename(dest);
  const jobId = `gh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 记录类型是 download（管理页显示「下载文件」）；TaskKind 只是进度事件的分类，用 generic
  const taskKind: TaskKind = "generic";
  // 「管理」页点继续时按这份参数续传：源地址用**解析后的**加速地址，
  // 换节点会让下载器认为远端文件变了（etag/url 对不上）从而从头下，断点续传就白费了。
  const resume = JSON.stringify({ resumeKind: "github", url: source, origin: parsed.href, dest, targetDir: dir, fileName: title });
  const base: TaskProgress = {
    taskId: jobId,
    kind: taskKind,
    label: title,
    stage: mt("github.stageDownload"),
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    filesDone: 0,
    filesTotal: 1,
  };
  const emit = (patch: Partial<TaskProgress>): void => {
    trackProgress({ ...base, ...patch, jobId });
  };
  const finish = (ok: boolean, error?: string): void => {
    trackResult({ taskId: jobId, kind: taskKind, label: title, ok, ...(error ? { error } : {}) });
  };
  const task: TaskHandle = {
    id: jobId,
    kind: taskKind,
    label: title,
    update: (patch) => emit(patch),
    done: () => finish(true),
    fail: (err) => finish(false, err instanceof Error ? err.message : String(err)),
  };

  // 第一条进度帧在任务槽位内发出：它真正建出这条记录并绑上取消句柄；
  // IPC 等它回来再返回，界面拿到的就是「已经在队列里」的那条记录。
  let announce: () => void = () => undefined;
  const created = new Promise<void>((resolve) => {
    announce = resolve;
  });

  // 一次性提示必须在 runCancellable 之前给出：它在建安装上下文时把这条提示摘走（scope.hint），
  // 上下文里再 hintNextJob 只会落进全局待摘队列、被下一次安装误用。
  // 这里到 runCancellable 之间没有 await，别的安装抢不走。
  hintNextJob({ kind: "download", detail: dir, resume });
  void runCancellable(async (signal) => {
    emit({ stage: mt("github.stageDownload") });
    announce();
    try {
      log.info(`下载 ${source} → ${dest}`);
      await downloadFile(source, dest, { task, signal, label: title });
      finish(true);
      log.info(`下载完成：${dest}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 取消不算失败：downloads 的 cancel() 已经把记录写成 cancelled，这条结果不会覆盖它
      finish(false, message);
      log.warn(`下载失败或已取消：${dest} · ${message}`);
    }
  }).catch((err) => {
    log.warn(`GitHub 下载任务异常：${err instanceof Error ? err.message : String(err)}`);
  });

  await created;
  const job = listDownloadJobs().find((item) => item.id === jobId);
  if (!job) throw new Error(mt("github.jobMissing"));
  return job;
}
