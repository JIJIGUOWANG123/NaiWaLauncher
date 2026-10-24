import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 兜底版本号（与 package.json 同步维护）。 */
const APP_VERSION_FALLBACK = "0.1.5";
import { logger } from "./logger";
import type { UpdateCheckResult } from "../../shared/types";
import { mt } from "./i18n";
import {
  GITHUB_NODES,
  LAUNCHER_REPO,
  accelerate,
  githubAcceleratedCandidates,
  githubAcceleratedPrefixes,
  normalizeBase,
} from "../net/github";

const log = logger("updates");
const REPO = LAUNCHER_REPO;
/** 更新包固定文件名：Release 里永远用这两个名字上传，所以 latest/download 直链永远指向最新版。 */
const PORTABLE_ASSET = "naiwalauncher.exe";
const SETUP_ASSET = "naiwalauncher-setup.exe";
/** 固定名直链：拿不到资产清单时也填上它，让「立即更新」真的能开始下载（下载仍走四节点加速候选）。 */
function fixedAssetUrl(name: string): string {
  return "https://github.com/" + REPO + "/releases/latest/download/" + name;
}

/**
 * 记住「哪些加速节点能代理 api.github.com」。
 * 七个节点里只有部分给 200（其余把 API 请求回成 403 错误页）；而按延迟排序时能代理的那个
 * 经常排在后面，于是先试的通道全 403。githubAcceleratedPrefixes 已按测速里的 apiProxy 先排，
 * 这里再补一层运行时学习：真正抓到 release JSON 的节点下次直接排最前。
 */
const apiProxyNodes: string[] = [];

function rememberApiNode(id: string, ok: boolean): void {
  const at = apiProxyNodes.indexOf(id);
  if (!ok) {
    if (at >= 0) apiProxyNodes.splice(at, 1);
    return;
  }
  if (at === 0) return;
  if (at > 0) apiProxyNodes.splice(at, 1);
  apiProxyNodes.unshift(id);
  if (apiProxyNodes.length > GITHUB_NODES.length) apiProxyNodes.length = GITHUB_NODES.length;
}

interface Channel {
  id: UpdateCheckResult["channel"];
  url: string;
  /** 只带前缀的 API 镜像通道：节点 id 用于记住它能不能代理 api。 */
  node?: string;
  /** 该通道能不能给出资产清单（只有 GitHub API 的 release JSON 能；jsDelivr/raw 只有 package.json）。 */
  assets: boolean;
}

/**
 * API 镜像通道：七个节点**全部**给出（顺序按测速且能代理 api 的排最前，再叠运行时学习）。
 * 只按测速取前二会把能代理的节点漏掉，所以这里不设上限。
 */
async function apiMirrorChannels(apiUrl: string): Promise<Channel[]> {
  const prefixes = await githubAcceleratedPrefixes();
  const idOf = (base: string): string => GITHUB_NODES.find((node) => normalizeBase(node.base) === base)?.id ?? base;
  const known = apiProxyNodes.filter((id) => prefixes.some((base) => idOf(base) === id));
  const knownBases = known.map((id) => prefixes.find((base) => idOf(base) === id)).filter((base): base is string => Boolean(base));
  const rest = prefixes.filter((base) => !known.includes(idOf(base)));
  return [...knownBases, ...rest].map((base) => ({
    id: "gh-proxy" as const,
    url: accelerate(base, apiUrl),
    node: idOf(base),
    assets: true,
  }));
}

/**
 * 通道（依次尝试）：官方 API → 七个加速节点的 API 镜像 → jsDelivr → raw 直连 → 加速节点的 raw 镜像。
 * 加速节点不再硬编码，统一走 githubAccelerator 的顺序（auto 先测速排序，固定节点优先）。
 */
async function buildChannels(): Promise<Channel[]> {
  const apiUrl = "https://api.github.com/repos/" + REPO + "/releases/latest";
  const rawUrl = "https://raw.githubusercontent.com/" + REPO + "/main/package.json";
  const apiMirrors = await apiMirrorChannels(apiUrl);
  // raw 通道只负责「拿到版本号」，仍只取测速前二：通道越多，全网被墙时等超时越久
  const rawMirrors = await githubAcceleratedCandidates(rawUrl, 2);
  return [
    { id: "github-api", url: apiUrl, assets: true },
    ...apiMirrors,
    { id: "jsdelivr", url: "https://cdn.jsdelivr.net/gh/" + REPO + "@main/package.json", assets: false },
    { id: "raw", url: rawUrl, assets: false },
    ...rawMirrors.map((url) => ({ id: "gh-proxy" as const, url, assets: false })),
  ];
}

function parseVersion(input: string): number[] {
  return String(input).replace(/^v/i, "").split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0);
}

/** a > b 返回正数，相等 0。 */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchJson(url: string): Promise<{ ok: boolean; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": `NaiWaLauncher/${app.getVersion()}`, Accept: "application/vnd.github+json, application/json" },
    });
    if (!res.ok) return { ok: false, data: null };
    return { ok: true, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 当前版本：打包后取 app.getVersion()；开发态（electron 直接跑脚本）会返回 Electron 版本，此时回落到 package.json。 */
function currentVersion(): string {
  const fromApp = app.getVersion();
  if (fromApp && fromApp !== process.versions.electron) return fromApp;
  try {
    const pkgPath = join(app.getAppPath(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* 忽略，使用下面的兜底 */
  }
  return APP_VERSION_FALLBACK;
}

interface ParsedRelease {
  latest: string;
  hasUpdate: boolean;
  url: string;
  notes?: string;
  publishedAt?: string;
  assetUrl?: string;
  setupUrl?: string;
  /** 通道给的都是 package.json 之类没有 assets 的 JSON：资产清单未知。 */
  assetsUnknown?: boolean;
  /** 通道明确给了 assets 数组（此时资产清单可信，哪怕为空）。 */
  assetsKnown: boolean;
}

/**
 * 解析一条通道的 JSON。
 * 资产清单有三种情况：
 * 1. 有 assets，且能找到固定名 → 用 release 给的真实直链；
 * 2. 有 assets 但没有固定名 → 仍用固定名直链兜底（文件多半只是改了大小写或换了个名字）；
 * 3. 根本没有 assets（镜像通道只有 package.json）→ assetsUnknown，URL 用固定名直链兜底；
 * 4. assets 明确是空数组 → 该版本确实没传包，URL 留空，界面才敢说「未提供自动更新包」。
 */
function parseRelease(payload: Record<string, unknown>, current: string): ParsedRelease | null {
  // release 通道：tag_name；jsDelivr/raw 通道：package.json 的 version
  const raw = typeof payload.tag_name === "string" ? payload.tag_name : typeof payload.version === "string" ? payload.version : "";
  if (!raw) return null;
  const latest = raw.replace(/^v/i, "");
  const hasUpdate = compareVersion(latest, current) > 0;
  const notes = typeof payload.body === "string" ? payload.body.slice(0, 800) : undefined;
  const publishedAt = typeof payload.published_at === "string" ? payload.published_at : undefined;
  const url = typeof payload.html_url === "string" ? payload.html_url : "https://github.com/" + REPO + "/releases";
  const assets = Array.isArray(payload.assets) ? (payload.assets as Record<string, unknown>[]) : null;
  const pick = (name: string): string | undefined => {
    const hit = assets?.find((item) => String(item.name || "").toLowerCase() === name);
    return hit && typeof hit.browser_download_url === "string" ? hit.browser_download_url : undefined;
  };
  let assetUrl: string | undefined;
  let setupUrl: string | undefined;
  let assetsUnknown: boolean | undefined;
  if (!assets) {
    // 镜像通道（package.json）没有资产清单：记下来，URL 用固定名兜底
    assetsUnknown = true;
    if (hasUpdate) {
      assetUrl = fixedAssetUrl("NaiWaLauncher.exe");
      setupUrl = fixedAssetUrl("NaiWaLauncher-Setup.exe");
    }
  } else if (assets.length > 0) {
    assetUrl = pick(PORTABLE_ASSET) ?? (hasUpdate ? fixedAssetUrl("NaiWaLauncher.exe") : undefined);
    setupUrl = pick(SETUP_ASSET) ?? (hasUpdate ? fixedAssetUrl("NaiWaLauncher-Setup.exe") : undefined);
  }
  return { latest, hasUpdate, url, notes, publishedAt, assetUrl, setupUrl, assetsUnknown, assetsKnown: assets !== null };
}

/** 检查更新：任何一个通道拿到版本号就算成功；全部失败返回 error 而不抛错。 */
export async function checkAppUpdates(): Promise<UpdateCheckResult> {
  const current = currentVersion();
  // 每次真正发起检查都留一行：日志里数这一行就知道「一次启动查了几次」（启动检查应当只有一次）
  log.info(`[updates] 发起检查（当前 ${current}）`);
  let lastError = "";
  // 先拿到的「有版本号但资产清单未知」的结果：继续找能给出资产清单的通道，找不到就用它
  let pending: UpdateCheckResult | null = null;
  for (const channel of await buildChannels()) {
    // 已经拿到版本号后，只有能给出资产清单的通道还值得再试（jsDelivr/raw 只会再花一次超时）
    if (pending && !channel.assets) continue;
    const { ok, data } = await fetchJson(channel.url);
    // 非 200 或 JSON 解析失败 = 这条通道失败（加速节点的 403 错误页会落在这里），
    // 绝不能当成「有更新但没有资产」
    if (!ok || !data || typeof data !== "object") {
      if (channel.node) rememberApiNode(channel.node, false);
      lastError = mt("upd.channelUnavailable", { channel: channel.id });
      continue;
    }
    const parsed = parseRelease(data as Record<string, unknown>, current);
    if (!parsed) {
      if (channel.node) rememberApiNode(channel.node, false);
      lastError = mt("upd.channelNoVersion", { channel: channel.id });
      continue;
    }
    if (channel.node) rememberApiNode(channel.node, true);
    const result: UpdateCheckResult = {
      current,
      latest: parsed.latest,
      hasUpdate: parsed.hasUpdate,
      url: parsed.url,
      channel: channel.id,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
      ...(parsed.publishedAt ? { publishedAt: parsed.publishedAt } : {}),
      ...(parsed.assetUrl ? { assetUrl: parsed.assetUrl } : {}),
      ...(parsed.setupUrl ? { setupUrl: parsed.setupUrl } : {}),
      ...(parsed.assetsUnknown ? { assetsUnknown: true } : {}),
    };
    log.info(
      `[updates] ${channel.id}${channel.node ? "(" + channel.node + ")" : ""} → 当前 ${current}，仓库 ${parsed.latest}` +
        `（${parsed.hasUpdate ? "有更新" : "已是最新"}，资产${parsed.assetsKnown ? "清单已知" : "清单未知"}）`,
    );
    // 资产清单可信（哪怕为空）就直接用：它是最权威的答案
    if (parsed.assetsKnown) return result;
    if (!pending) pending = result;
  }
  if (pending) {
    log.warn(`[updates] 只有镜像通道可用（${pending.channel}）：版本号已拿到，资产清单未知，已按固定文件名兜底`);
    return pending;
  }
  log.warn(`[updates] 检查更新失败：${lastError || "所有通道不可用"}`);
  return { current, latest: null, hasUpdate: false, channel: "none", error: lastError || mt("upd.githubUnreachable") };
}
