import type { ServerBuildInfo, ServerCoreId, ServerCoreInfo } from "../../shared/types";
import { fetchJson } from "../core/http";
import { logger } from "../core/logger";

const log = logger("servers/fastmirror");

const BASE = "https://download.fastmirror.net";
/** 5 分钟内存缓存：核心清单与构建列表在一次会话里会被反复打开。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 只做 Java 版核心；核心名大小写敏感（Paper 有效，paper 返回 0 条）。 */
export const JAVA_CORES: readonly ServerCoreId[] = [
  "Vanilla",
  "Paper",
  "Purpur",
  "Folia",
  "Fabric",
  "Forge",
  "NeoForge",
  "Arclight",
];

/**
 * 合法游戏版本：正式版 1.21.4 / 新版本号 26.1 / 预发布 1.21-pre1、26.3-rc-3、
 * 快照 26w14a、带加载器后缀的 1.21-neoforge（Arclight 用）。
 * 排除 general、"3D Shareware v1.34" 这类非游戏版本值。
 */
const MC_VERSION = /^(?:\d+(?:\.\d+)+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?|\d{2}w\d{2}[a-z])$/i;

interface Envelope<T> {
  success?: boolean;
  code?: string;
  message?: string;
  data?: T;
}

interface RawCore {
  name?: unknown;
  tag?: unknown;
  homepage?: unknown;
  recommend?: unknown;
  mc_versions?: unknown;
}

interface RawBuild {
  name?: unknown;
  mc_version?: unknown;
  core_version?: unknown;
  update_time?: unknown;
  sha1?: unknown;
}

interface RawResolve extends RawBuild {
  filename?: unknown;
  download_url?: unknown;
}

export interface ResolvedBuild {
  core: ServerCoreId;
  mcVersion: string;
  coreVersion: string;
  filename: string;
  downloadUrl: string;
  sha1: string;
}

const cache = new Map<string, { at: number; value: unknown }>();

export function clearCache(): void {
  cache.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 信封校验：失败包成可读错误（FastMirror 的 message 通常是英文短句）。 */
function unwrap<T>(payload: unknown, what: string): T {
  if (!payload || typeof payload !== "object") {
    throw new Error(`FastMirror ${what}返回格式异常：不是 JSON 对象`);
  }
  const envelope = payload as Envelope<T>;
  if (envelope.success === false) {
    const reason = text(envelope.message) || text(envelope.code) || "未知原因";
    throw new Error(`FastMirror ${what}失败：${reason}`);
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new Error(`FastMirror ${what}未返回数据`);
  }
  return envelope.data;
}

export function isCoreId(value: unknown): value is ServerCoreId {
  return typeof value === "string" && (JAVA_CORES as readonly string[]).includes(value);
}

export function isMcVersion(value: unknown): value is string {
  return typeof value === "string" && MC_VERSION.test(value.trim());
}

function coreOrder(core: ServerCoreId): number {
  return JAVA_CORES.indexOf(core);
}

/** 纯解析：/api/v3 的核心数组，只留 8 个 Java 核心。 */
export function parseCores(payload: unknown): ServerCoreInfo[] {
  const data = unwrap<unknown>(payload, "核心清单");
  if (!Array.isArray(data)) throw new Error("FastMirror 核心清单返回格式异常：data 不是数组");

  const seen = new Set<string>();
  const out: ServerCoreInfo[] = [];
  for (const raw of data as RawCore[]) {
    if (!raw || typeof raw !== "object") continue;
    const name = text(raw.name);
    // 大小写敏感：只有白名单里完全相同拼写的核心才算
    if (!isCoreId(name) || seen.has(name)) continue;
    seen.add(name);
    const versions = Array.isArray(raw.mc_versions) ? raw.mc_versions : [];
    const mcVersions = [...new Set(versions.filter((v): v is string => isMcVersion(v)).map((v) => v.trim()))];
    const homepage = text(raw.homepage);
    out.push({
      core: name,
      tag: text(raw.tag),
      ...(homepage ? { homepage } : {}),
      mcVersions,
      recommend: raw.recommend === true,
    });
  }
  out.sort((a, b) => coreOrder(a.core) - coreOrder(b.core));
  return out;
}

/** 纯解析：/{core}/{mcVersion} 的 builds 数组。 */
export function parseBuilds(payload: unknown, core: ServerCoreId, mcVersion: string): ServerBuildInfo[] {
  const data = unwrap<unknown>(payload, `${core} ${mcVersion} 的构建列表`);
  const builds = (data as { builds?: unknown }).builds;
  if (!Array.isArray(builds)) throw new Error("FastMirror 构建列表返回格式异常：data.builds 不是数组");

  const out: ServerBuildInfo[] = [];
  for (const raw of builds as RawBuild[]) {
    if (!raw || typeof raw !== "object") continue;
    const coreVersion = text(raw.core_version);
    if (!coreVersion) continue;
    out.push({
      core,
      mcVersion: text(raw.mc_version) || mcVersion,
      coreVersion,
      sha1: text(raw.sha1),
      updateTime: text(raw.update_time),
    });
  }
  return out;
}

/** 纯解析：/{core}/{mcVersion}/{coreVersion} 的单条构建，拿到 jar 文件名与下载地址。 */
export function parseBuild(payload: unknown, core: ServerCoreId, mcVersion: string, coreVersion: string): ResolvedBuild {
  const data = unwrap<unknown>(payload, `${core} ${coreVersion} 的构建详情`);
  const raw = data as RawResolve;
  if (!raw || typeof raw !== "object") throw new Error("FastMirror 构建详情返回格式异常");
  const downloadUrl = text(raw.download_url);
  if (!downloadUrl) throw new Error(`FastMirror 未返回 ${core} ${coreVersion} 的下载地址`);
  const sha1 = text(raw.sha1);
  if (!sha1) throw new Error(`FastMirror 未返回 ${core} ${coreVersion} 的 SHA1，无法校验下载`);
  return {
    core,
    mcVersion: text(raw.mc_version) || mcVersion,
    coreVersion: text(raw.core_version) || coreVersion,
    filename: text(raw.filename),
    downloadUrl,
    sha1,
  };
}

function api<T>(path: string): Promise<T> {
  // allowMirror=false：FastMirror 自有 CDN，不该被国内镜像改写
  return fetchJson<T>(BASE + path, { allowMirror: false, retries: 2 });
}

export async function listCores(): Promise<ServerCoreInfo[]> {
  return await cached("cores", async () => {
    const cores = parseCores(await api<unknown>("/api/v3"));
    log.info(`FastMirror 核心清单：${cores.map((c) => c.core).join("、") || "（空）"}`);
    return cores;
  });
}

export async function listBuilds(core: ServerCoreId, mcVersion: string): Promise<ServerBuildInfo[]> {
  if (!isCoreId(core)) throw new Error(`不支持的服务端核心：${String(core)}`);
  const version = text(mcVersion);
  if (!version) throw new Error("游戏版本不能为空");
  return await cached(`builds:${core}:${version}`, async () =>
    parseBuilds(await api<unknown>(`/api/v3/${core}/${encodeURIComponent(version)}?offset=0&limit=25`), core, version),
  );
}

export async function resolveBuild(core: ServerCoreId, mcVersion: string, coreVersion: string): Promise<ResolvedBuild> {
  if (!isCoreId(core)) throw new Error(`不支持的服务端核心：${String(core)}`);
  const version = text(mcVersion);
  const build = text(coreVersion);
  if (!version) throw new Error("游戏版本不能为空");
  if (!build) throw new Error("核心构建不能为空");
  return await cached(`build:${core}:${version}:${build}`, async () =>
    parseBuild(
      await api<unknown>(`/api/v3/${core}/${encodeURIComponent(version)}/${encodeURIComponent(build)}`),
      core,
      version,
      build,
    ),
  );
}
