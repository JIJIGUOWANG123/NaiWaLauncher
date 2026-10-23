import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 兜底版本号（与 package.json 同步维护）。 */
const APP_VERSION_FALLBACK = "0.1.5";
import { logger } from "./logger";
import type { UpdateCheckResult } from "../../shared/types";
import { mt } from "./i18n";

const log = logger("updates");
const REPO = "JIJIGUOWANG123/NaiWaLauncher";

/** 三个通道依次尝试：官方 API → gh-proxy 镜像 → jsDelivr（读仓库 package.json 的 version）。 */
const CHANNELS: { id: UpdateCheckResult["channel"]; url: string }[] = [
  { id: "github-api", url: `https://api.github.com/repos/${REPO}/releases/latest` },
  { id: "gh-proxy", url: `https://gh-proxy.com/https://api.github.com/repos/${REPO}/releases/latest` },
  { id: "sakuramoe", url: `https://ghproxy.sakuramoe.dev/https://raw.githubusercontent.com/${REPO}/main/package.json` },
  { id: "jsdelivr", url: `https://cdn.jsdelivr.net/gh/${REPO}@main/package.json` },
  { id: "raw", url: `https://raw.githubusercontent.com/${REPO}/main/package.json` },
];

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

/** 检查更新：任何一个通道拿到版本号就算成功；全部失败返回 error 而不抛错。 */
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

export async function checkAppUpdates(): Promise<UpdateCheckResult> {
  const current = currentVersion();
  let lastError = "";
  for (const channel of CHANNELS) {
    const { ok, data } = await fetchJson(channel.url);
    if (!ok || !data || typeof data !== "object") {
      lastError = mt("upd.channelUnavailable", { channel: channel.id });
      continue;
    }
    const payload = data as Record<string, unknown>;
    // release 通道：tag_name；jsDelivr 通道：package.json 的 version
    const raw = typeof payload.tag_name === "string" ? payload.tag_name : typeof payload.version === "string" ? payload.version : "";
    if (!raw) {
      lastError = mt("upd.channelNoVersion", { channel: channel.id });
      continue;
    }
    const latest = raw.replace(/^v/i, "");
    const hasUpdate = compareVersion(latest, current) > 0;
    const notes = typeof payload.body === "string" ? payload.body.slice(0, 800) : undefined;
    const publishedAt = typeof payload.published_at === "string" ? payload.published_at : undefined;
    const url = typeof payload.html_url === "string" ? payload.html_url : `https://github.com/${REPO}/releases`;
    // Release 里找免安装版资源（NaiWaLauncher.exe，不带版本号）
    const assets = Array.isArray(payload.assets) ? (payload.assets as Record<string, unknown>[]) : [];
    const exeAsset = assets.find((a) => String(a.name || "").toLowerCase() === "naiwalauncher.exe");
    const assetUrl = exeAsset && typeof exeAsset.browser_download_url === "string" ? exeAsset.browser_download_url : undefined;
    // 安装版更新包用固定文件名（NaiWaLauncher-Setup.exe），永远指向最新版
    const setupAsset = assets.find((a) => String(a.name || "").toLowerCase() === "naiwalauncher-setup.exe");
    const setupUrl = setupAsset && typeof setupAsset.browser_download_url === "string" ? setupAsset.browser_download_url : undefined;
    log.info(`[updates] ${channel.id} → 当前 ${current}，仓库 ${latest}（${hasUpdate ? "有更新" : "已是最新"}）`);
    return { current, latest, hasUpdate, url, notes, publishedAt, channel: channel.id, assetUrl, setupUrl };
  }
  log.warn(`[updates] 检查更新失败：${lastError || "所有通道不可用"}`);
  return { current, latest: null, hasUpdate: false, channel: "none", error: lastError || mt("upd.githubUnreachable") };
}
