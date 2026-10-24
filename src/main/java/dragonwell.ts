// Alibaba Dragonwell：官方站点 dragonwell-jdk.io 是 SPA（静态 HTML 里没有任何下载链接），
// 真实地址来自两处（都实测过）：
//   1) GitHub Releases API：https://api.github.com/repos/dragonwell-project/dragonwell{major}/releases/latest
//      → assets 里有 Alibaba_Dragonwell_Standard_<ver>_x64_windows.zip 与 .zip.sha256.txt
//   2) 官方 wiki「下载镜像」给出的阿里云 OSS 前缀（国内更快）：
//      https://dragonwell.oss-cn-shanghai.aliyuncs.com/{tag 里的版本}/{asset 文件名}
//      实测 21.0.12.0.12%2B8/Alibaba_Dragonwell_Standard_21.0.12.0.12.8_x64_windows.zip
//      → 206 / zip 魔数 / 大小 203,549,969 与 GitHub 资产一致，sha256 侧车也能取到且与实际文件相符。
// 所以：清单走 GitHub API（拿版本号 + 大小 + 哈希侧车），下载优先走阿里云 OSS，失败再回 GitHub。
import type { InstalledJava, JavaRelease } from "../../shared/types";
import { fetchJson, fetchText } from "../core/http";
import { logger } from "../core/logger";
import { mt } from "../core/i18n";
import type { ManagedSource } from "./vendor";
import { installZipRelease } from "./zipinstall";

const log = logger("java/dragonwell");

const GH_API = "https://api.github.com/repos/dragonwell-project";
const OSS_BASE = "https://dragonwell.oss-cn-shanghai.aliyuncs.com";
/** 与其它源保持一致的主版本列表（MC 26.x 起需要 25）。 */
export const DRAGONWELL_MAJORS = [8, 17, 21, 25];
const LTS_MAJORS = new Set([8, 11, 17, 21, 25]);
const CACHE_TTL_MS = 10 * 60_000;

export type DragonwellSource = Extract<ManagedSource, "dragonwell">;

/** 官方 wiki 的 OSS 路径就是 tag 里的版本串（8.30.29 / 21.0.12.0.12+8）。 */
export function ossUrl(version: string, fileName: string): string {
  return OSS_BASE + "/" + encodeURIComponent(version) + "/" + fileName;
}

/** dragonwell-standard-21.0.12.0.12+8_jdk-21.0.12-ga → 21.0.12.0.12+8。 */
export function versionOfTag(tag: string): string {
  const tail = tag.replace(/^dragonwell-(?:standard|extended)-/i, "");
  const cut = tail.indexOf("_");
  return (cut > 0 ? tail.slice(0, cut) : tail).trim();
}

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

/**
 * 纯函数：GitHub release JSON → 取 Windows 64 位 zip 资产（自检用夹具断言）。
 * 25 那个版本同时有 _x64_windows-fix.zip，优先无后缀的正式包。
 */
export function pickWindowsAsset(assets: GhAsset[]): GhAsset | undefined {
  const zips = assets.filter((asset) => /_x64_windows\.zip$/i.test(asset.name));
  const standard = zips.filter((asset) => /_Standard_/i.test(asset.name));
  const pool = standard.length > 0 ? standard : zips;
  return pool[0];
}

/** 从 .sha256.txt 侧车（内容形如「<hex>  target/…zip」）里抠出 64 位十六进制哈希。 */
export function sha256OfSidecar(text: string): string | undefined {
  return /\b([0-9a-f]{64})\b/i.exec(text)?.[1]?.toLowerCase();
}

interface CacheEntry {
  at: number;
  releases: JavaRelease[];
}

const cache = new Map<number, CacheEntry>();
/** 下载兜底地址：清单里只放得下一个 downloadUrl，GitHub 那条记在这里（装的时候取）。 */
const fallbackOf = new WeakMap<JavaRelease, string>();

async function sha256Sidecar(url: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const text = await fetchText(url, { allowMirror: false, timeoutMs: 15000, retries: 1, signal });
    return sha256OfSidecar(text);
  } catch (err) {
    // 侧车拿不到不影响安装：那时只能按大小校验
    log.warn("读取 Dragonwell 哈希失败（" + url + "）：" + (err instanceof Error ? err.message : String(err)));
    return undefined;
  }
}

/** 一个主版本的最新版（GitHub API 只给 latest，没有历史版本列表）。 */
export async function listReleases(
  major: number,
  source: DragonwellSource = "dragonwell",
  signal?: AbortSignal,
): Promise<JavaRelease[]> {
  const hit = cache.get(major);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.releases;
  const repo = GH_API + "/dragonwell" + major + "/releases/latest";
  let body: unknown;
  try {
    body = await fetchJson<unknown>(repo, {
      allowMirror: false,
      timeoutMs: 20000,
      signal,
      headers: { "User-Agent": "NaiWa-Launcher", Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    throw new Error(mt("java.adoptium.listFailed", {
      major,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  const release = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const rawAssets = Array.isArray(release.assets) ? release.assets : [];
  const assets: GhAsset[] = rawAssets
    .map((item) => (item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {}))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      size: typeof item.size === "number" ? item.size : 0,
      browser_download_url: typeof item.browser_download_url === "string" ? item.browser_download_url : "",
    }))
    .filter((asset) => asset.name.length > 0);
  const asset = pickWindowsAsset(assets);
  const version = versionOfTag(tag);
  if (!asset || !version) throw new Error(mt("java.adoptium.noRelease", { major }));
  const downloadUrl = ossUrl(version, asset.name);
  const sha256 = await sha256Sidecar(downloadUrl + ".sha256.txt", signal);
  const item: JavaRelease = {
    version,
    major,
    lts: LTS_MAJORS.has(major),
    downloadUrl,
    fileName: asset.name,
    ...(asset.size > 0 ? { sizeBytes: asset.size } : {}),
    ...(sha256 ? { sha256 } : {}),
    source,
  };
  fallbackOf.set(item, asset.browser_download_url);
  const releases = [item];
  cache.set(major, { at: Date.now(), releases });
  return releases;
}

/** 探测时实际读取的字节数：与其它源「拉一个目录页 / 一个 JSON」同量级的成本。 */
const PROBE_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MS = 5000;

/**
 * 测速：Range 取最新版 zip 的前 32KB。
 * 不用 sha256 侧车那种百来字节的小文件——那会把 CDN 边缘延迟算得过分好看，
 * auto 测速时要和「拉目录页 / 拉 API」的其它源比才有意义。
 */
export async function probeLatency(signal?: AbortSignal): Promise<number> {
  const releases = await listReleases(21, "dragonwell", signal);
  const hit = releases[0];
  if (!hit) throw new Error(mt("java.adoptium.noRelease", { major: 21 }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(hit.downloadUrl, {
      headers: { range: "bytes=0-" + (PROBE_BYTES - 1), "user-agent": "NaiWa-Launcher" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("HTTP " + res.status);
    }
    const reader = res.body?.getReader();
    let got = 0;
    while (reader && got < PROBE_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      got += chunk.value?.byteLength ?? 0;
    }
    await reader?.cancel().catch(() => undefined);
    return Date.now() - started;
  } finally {
    clearTimeout(timer);
  }
}

/** 所有主版本的汇总列表（单个主版本失败只丢那一档）。 */
export async function listAllReleases(
  majors: number[] = DRAGONWELL_MAJORS,
  source: DragonwellSource = "dragonwell",
): Promise<JavaRelease[]> {
  const settled = await Promise.all(
    majors.map(async (major) => {
      try {
        return await listReleases(major, source);
      } catch (err) {
        log.warn("获取 Dragonwell JDK " + major + " 列表失败：" + (err instanceof Error ? err.message : String(err)));
        return [] as JavaRelease[];
      }
    }),
  );
  return settled.flat().sort((a, b) => a.major - b.major);
}

export async function install(
  major: number,
  version: string | undefined,
  signal?: AbortSignal,
): Promise<InstalledJava> {
  const releases = await listReleases(major, "dragonwell", signal);
  const hit = releases[0];
  if (!hit) throw new Error(mt("java.adoptium.noRelease", { major }));
  const want = (version ?? "").trim();
  // 接口只给「最新版」：指定版本与最新版不同时按最新版装（界面列表也来自同一个接口）
  if (want && want !== hit.version) {
    log.warn("指定版本 " + want + " 不是 Dragonwell 当前最新版（" + hit.version + "），按最新版安装");
  }
  const fallback = fallbackOf.get(hit);
  return installZipRelease({ ...hit, source: "dragonwell" }, signal, {
    fallbackUrls: fallback ? [fallback] : [],
  });
}
