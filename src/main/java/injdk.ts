// d10.injdk.cn（第三方镜像，fancyindex 风格目录列表）上的 Azul Zulu 与 Oracle JDK。
//
// 实测目录层级（2026-10 抓取）：
//   https://d10.injdk.cn/openjdk/zulu/                 → 8/ 11/ 17/ 21/ 25/ 26/ 27/
//   https://d10.injdk.cn/openjdk/zulu/21/              → .../zulu21.50.19-ca-jdk21.0.11-win_x64.zip（211,614,661）
//   https://d10.injdk.cn/openjdk/oraclejdk/            → 8/ 11/ 21/ 25/ 26/（没有 17）
//   https://d10.injdk.cn/openjdk/oraclejdk/21/         → ./jdk-21_windows-x64_bin.zip（195,509,109）
//   https://d10.injdk.cn/openjdk/oraclejdk/8/          → ./jdk-8u491-windows-x64.zip
// 列表页给的是「名字 + data-size」，没有任何哈希 → 只能按大小校验。
//
// 合规：Oracle JDK 的许可禁止第三方再分发，这里只是镜像上的可选项，界面会提示；
// auto 测速也不把它当成默认源（见 sources.ts）。
import type { InstalledJava, JavaRelease } from "../../shared/types";
import { fetchText } from "../core/http";
import { logger } from "../core/logger";
import { mt } from "../core/i18n";
import type { ManagedSource } from "./vendor";
import { installZipRelease } from "./zipinstall";

const log = logger("java/injdk");

const BASE = "https://d10.injdk.cn/openjdk";
/** 目录名：zulu → zulu/，oracle → oraclejdk/。 */
const DIRS = { zulu: "zulu", oracle: "oraclejdk" } as const;
/** 与 Liberica / Adoptium 保持一致的主版本列表（MC 26.x 起需要 25）。 */
export const INJDK_MAJORS = [8, 17, 21, 25];
const LTS_MAJORS = new Set([8, 11, 17, 21, 25]);
/** 列表缓存 10 分钟：Java 页会反复拉同一批主版本。 */
const CACHE_TTL_MS = 10 * 60_000;

export type InjdkSource = Extract<ManagedSource, "zulu" | "oracle">;

export function isInjdkSource(value: ManagedSource): value is InjdkSource {
  return value === "zulu" || value === "oracle";
}

/** 某个主版本的目录列表地址（探测也复用它）。 */
export function listingUrl(source: InjdkSource, major: number): string {
  return BASE + "/" + DIRS[source] + "/" + major + "/";
}

export interface ListingEntry {
  name: string;
  sizeBytes: number;
  url: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 纯函数：目录列表 HTML → 条目（自检用夹具直接断言）。
 * 每行是 <tr class="file">…<a href="./名字">…<span class="name">名字</span>…data-size="字节数"。
 */
export function parseListing(html: string, baseUrl: string): ListingEntry[] {
  const out: ListingEntry[] = [];
  for (const chunk of html.split('<tr class="file">').slice(1)) {
    const row = chunk.split("</tr>")[0] ?? "";
    const name = decodeEntities((/<span class="name">([^<]*)<\/span>/.exec(row)?.[1] ?? "").trim());
    if (!name || name.endsWith("/")) continue;
    const href = /href="([^"]+)"/.exec(row)?.[1] ?? "";
    if (!href || href.startsWith("?")) continue;
    const size = Number.parseInt(/data-size="(\d+)"/.exec(row)?.[1] ?? "0", 10);
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    out.push({ name, sizeBytes: Number.isFinite(size) ? size : 0, url });
  }
  return out;
}

/** Windows 64 位 zip：zulu 是 -win_x64.zip，oracle 是 -windows-x64(.zip|_bin.zip)。 */
const WINDOWS_ZIP = {
  zulu: /-win_x64\.zip$/i,
  oracle: /^jdk-.+windows-x64(_bin)?\.zip$/i,
} as const;

/** 目录名 → 版本号：zulu21.50.19-ca-jdk21.0.11-win_x64.zip → 21.0.11；jdk-8u491-windows-x64.zip → 8u491。 */
export function versionOf(source: InjdkSource, fileName: string): string {
  const exact = source === "zulu"
    ? /-jdk(\d+(?:\.\d+)+)-/i.exec(fileName)
    : /^jdk-(\d+(?:u\d+)?)[-_]/i.exec(fileName);
  return exact?.[1] ?? "";
}

function rank(version: string): number[] {
  return version.split(/[^0-9]+/).filter(Boolean).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionDesc(a: string, b: string): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
    const d = (rb[i] ?? 0) - (ra[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface CacheEntry {
  at: number;
  releases: JavaRelease[];
}

const cache = new Map<string, CacheEntry>();

/** 一个主版本目录下的所有 Windows 64 位 zip（同一目录可能堆着多个补丁版本）。 */
export async function listReleases(
  major: number,
  source: InjdkSource,
  signal?: AbortSignal,
): Promise<JavaRelease[]> {
  const key = source + "-" + major;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.releases;
  const dirUrl = listingUrl(source, major);
  let html: string;
  try {
    html = await fetchText(dirUrl, { allowMirror: false, timeoutMs: 15000, retries: 1, signal });
  } catch (err) {
    // 目录不存在（例如 oraclejdk 没有 17）也走这里：当成「这个主版本没有」，不打断整页列表
    throw new Error(mt("java.adoptium.listFailed", {
      major,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  const releases = parseListing(html, dirUrl)
    .filter((entry) => WINDOWS_ZIP[source].test(entry.name))
    .map((entry): JavaRelease => {
      const version = versionOf(source, entry.name) || String(major);
      return {
        version,
        major,
        lts: LTS_MAJORS.has(major),
        downloadUrl: entry.url,
        fileName: entry.name,
        ...(entry.sizeBytes > 0 ? { sizeBytes: entry.sizeBytes } : {}),
        source,
      };
    })
    .sort((a, b) => compareVersionDesc(a.version, b.version));
  cache.set(key, { at: Date.now(), releases });
  return releases;
}

/** 所有主版本的汇总列表（单个主版本失败只丢那一档，不整页报错）。 */
export async function listAllReleases(
  source: InjdkSource,
  majors: number[] = INJDK_MAJORS,
): Promise<JavaRelease[]> {
  const settled = await Promise.all(
    majors.map(async (major) => {
      try {
        return await listReleases(major, source);
      } catch (err) {
        log.warn("获取 " + source + " JDK " + major + " 列表失败：" + (err instanceof Error ? err.message : String(err)));
        return [] as JavaRelease[];
      }
    }),
  );
  return settled.flat().sort((a, b) => a.major - b.major || compareVersionDesc(a.version, b.version));
}

/** version 精确匹配优先，其次前缀匹配，最后退到该主版本最新版。 */
function pick(releases: JavaRelease[], want: string): JavaRelease | undefined {
  if (!want) return releases[0];
  return releases.find((item) => item.version === want)
    ?? releases.find((item) => item.version.startsWith(want))
    ?? releases[0];
}

export async function install(
  major: number,
  version: string | undefined,
  source: InjdkSource,
  signal?: AbortSignal,
): Promise<InstalledJava> {
  const releases = await listReleases(major, source, signal);
  if (releases.length === 0) {
    throw new Error(mt("java.liberica.noZip", { major }));
  }
  const want = (version ?? "").trim();
  const hit = pick(releases, want);
  if (!hit) throw new Error(mt("java.liberica.noVersion", {
    major,
    want,
    available: releases.slice(0, 5).map((item) => item.version).join(", "),
  }));
  return installZipRelease({ ...hit, source }, signal);
}
