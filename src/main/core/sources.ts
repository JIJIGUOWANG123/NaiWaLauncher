import type { DownloadSourceId, DownloadSourceInfo, SourceProbe } from "../../shared/types";
import { getSettings, updateSettings } from "./settings";

/** 具体下载源；auto 是选择器，不是源。 */
type ConcreteSource = Exclude<DownloadSourceId, "auto">;

const BMCLAPI_BASE = "https://bmclapi2.bangbang93.com";
/**
 * 上海交大镜像只镜像 Maven 依赖库（目录索引下是 asm/、net/ 这类分组路径）。
 * 实测：GET /bmclapi/org/ow2/asm/asm/9.6/asm-9.6.jar → 206，
 *       GET /bmclapi/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar → 206，
 *       GET /bmclapi/mc/game/version_manifest_v2.json → 404，
 *       GET /bmclapi/assets/00/000c82756f… → 404（同对象在 resources/bmclapi 上是 206），
 * 即它没有整站 BMCLAPI 接口、也没镜像 assets，所以这里只接管 libraries.minecraft.net；
 * 其它域名原样返回官方地址，由 http 层的跨源回退兜底。
 */
const SJTU_BASE = "https://mirror.sjtu.edu.cn/bmclapi";

// FastMinecraftMirror 已移除：镜像站长期不可达（子域解析到劫持 IP、证书不匹配），用户要求下线。

export const SOURCES: DownloadSourceInfo[] = [
  { id: "official", name: "官方源", description: "Mojang 官方下载", baseUrl: "https://launchermeta.mojang.com", selectable: true },
  { id: "bmclapi", name: "BMCLAPI 镜像", description: "国内镜像加速，接口与资源全量镜像", baseUrl: BMCLAPI_BASE, selectable: true },
  { id: "sjtu", name: "上海交大镜像", description: "只镜像 Maven 依赖库，其余走官方；缺失的文件自动回退", baseUrl: SJTU_BASE, selectable: true },
  { id: "auto", name: "自动选择", description: "按实测延迟自动切换，跳过不可用镜像", selectable: true },
];

const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const PROBE_TIMEOUT_MS = 8000;
const AUTO_TTL_MS = 10 * 60 * 1000;

/** 每个源用多条真实可达的 URL 实测，取中位数，避免单条线路抖动影响判定。 */
const PROBE_URLS: Record<ConcreteSource, string[]> = {
  official: [
    "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "https://launchermeta.mojang.com/mc/game/version_manifest.json",
  ],
  bmclapi: [
    "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
    "https://bmclapi2.bangbang93.com/maven/org/ow2/asm/asm/9.6/asm-9.6.jar",
    "https://bmclapi2.bangbang93.com/mc/game/version_manifest.json",
  ],
  // 交大没有版本清单接口（404），只能拿库文件测
  sjtu: [
    "https://mirror.sjtu.edu.cn/bmclapi/org/ow2/asm/asm/9.6/asm-9.6.jar",
    "https://mirror.sjtu.edu.cn/bmclapi/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar",
  ],
};

const ALL_SOURCES: ConcreteSource[] = ["official", "bmclapi", "sjtu"];
/**
 * auto 只在「能力等价」的源之间择优，所以候选镜像只有全量镜像 bmclapi。
 * sjtu 只镜像依赖库（清单与 assets 实测 404），放进候选会让清单和 assets 退回官方、反而更慢；
 * 它仍保留在 SOURCES 里供手动选择，手动选中时只改写 libraries。
 */
const AUTO_MIRROR: ConcreteSource = "bmclapi";

interface AutoState {
  at: number;
  officialMs: number | null;
  mirrorMs: number | null;
  decided: DownloadSourceId;
}

let autoState: AutoState | null = null;
let probeInflight: Promise<SourceProbe[]> | null = null;

/**
 * 官方地址 → 当前源的等价值地址。
 * 各源的路径规则不同：bmclapi 用 /maven、/assets 前缀；交大只有 /bmclapi/<maven 路径>。
 * 未收录的主机一律返回官方地址，避免镜像站返回 404。
 */
export function mapUrl(officialUrl: string, source: DownloadSourceId): string {
  if (!officialUrl) return officialUrl;
  const resolved = resolveBase(source);
  if (resolved === "official") return officialUrl;

  let parsed: URL;
  try {
    parsed = new URL(officialUrl);
  } catch {
    return officialUrl;
  }

  const host = parsed.hostname.toLowerCase();
  const suffix = parsed.pathname + parsed.search;

  if (resolved === "bmclapi") {
    switch (host) {
      case "launchermeta.mojang.com":
      case "piston-meta.mojang.com":
      case "piston-data.mojang.com":
      case "launcher.mojang.com":
        return BMCLAPI_BASE + suffix;
      case "libraries.minecraft.net":
        return BMCLAPI_BASE + "/maven" + suffix;
      case "resources.download.minecraft.net":
        return BMCLAPI_BASE + "/assets" + suffix;
      default:
        return officialUrl;
    }
  }

  // 交大只接管库文件，其余域名原样返回官方地址
  return host === "libraries.minecraft.net" ? SJTU_BASE + suffix : officialUrl;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

type HealthyProbe = SourceProbe & { latencyMs: number };

function isHealthy(probe: SourceProbe | undefined): probe is HealthyProbe {
  return probe !== undefined && probe.ok && typeof probe.latencyMs === "number" && probe.latencyMs >= 0;
}

/**
 * auto 判定：只比 official 与 bmclapi（sjtu 能力不对等，不参与）。
 * bmclapi 不可用 → 直接用官方；官方不可用或超过阈值 → 换 bmclapi；否则镜像明显更快才换。
 */
function decide(probes: Record<ConcreteSource, SourceProbe>, thresholdMs: number): ConcreteSource {
  const official = probes.official;
  const mirror = probes[AUTO_MIRROR];
  if (!isHealthy(mirror)) return "official";
  if (!isHealthy(official)) return "bmclapi";
  if (official.latencyMs > thresholdMs) return "bmclapi";
  if (mirror.latencyMs < official.latencyMs) return "bmclapi";
  return "official";
}

function computeAuto(probes: Record<ConcreteSource, SourceProbe>, thresholdMs: number): AutoState {
  return {
    at: Date.now(),
    officialMs: probes.official.latencyMs,
    mirrorMs: probes[AUTO_MIRROR].latencyMs,
    decided: decide(probes, thresholdMs),
  };
}

export function resolveBase(source: DownloadSourceId): DownloadSourceId {
  if (source !== "auto") return source;

  const fresh = autoState && Date.now() - autoState.at < AUTO_TTL_MS;
  if (autoState && !fresh) {
    // 过期即后台刷新，本次仍用旧结论，避免阻塞调用方
    void probeSources().catch(() => undefined);
  }
  if (fresh && autoState) return autoState.decided;

  // 尚无实测数据：国内网络下镜像成功率更高，先走镜像并异步探测
  void probeSources().catch(() => undefined);
  return autoState?.decided ?? "bmclapi";
}

async function measure(url: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "cache-control": "no-cache" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    // 只取首块数据，测的是首字节延迟而不是整包大小
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
    }
    return Date.now() - startedAt;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOne(source: ConcreteSource): Promise<SourceProbe> {
  const samples: number[] = [];
  let lastError = "";
  for (const url of PROBE_URLS[source]) {
    try {
      samples.push(await measure(url, PROBE_TIMEOUT_MS));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (samples.length === 0) {
    return { sourceId: source, ok: false, latencyMs: null, error: lastError || "探测失败" };
  }
  return { sourceId: source, ok: true, latencyMs: median(samples) };
}

async function doProbe(): Promise<SourceProbe[]> {
  const list = await Promise.all(ALL_SOURCES.map((source) => probeOne(source)));
  const probes = new Map<DownloadSourceId, SourceProbe>(list.map((probe) => [probe.sourceId, probe]));
  const byId = probes as Map<ConcreteSource, SourceProbe>;
  autoState = computeAuto(
    {
      official: byId.get("official") ?? { sourceId: "official", ok: false, latencyMs: null },
      bmclapi: byId.get("bmclapi") ?? { sourceId: "bmclapi", ok: false, latencyMs: null },
      sjtu: byId.get("sjtu") ?? { sourceId: "sjtu", ok: false, latencyMs: null },
    },
    getSettings().autoSwitchThresholdMs,
  );
  const chosen: SourceProbe =
    probes.get(autoState.decided as ConcreteSource) ?? byId.get("bmclapi") ?? { sourceId: "bmclapi", ok: false, latencyMs: null };
  return [
    ...list,
    { sourceId: "auto", ok: chosen.ok, latencyMs: chosen.latencyMs, ...(chosen.error === undefined ? {} : { error: chosen.error }) },
  ];
}

export async function probeSources(): Promise<SourceProbe[]> {
  if (probeInflight) return probeInflight;
  const run = doProbe().finally(() => {
    if (probeInflight === run) probeInflight = null;
  });
  probeInflight = run;
  return run;
}

export function setActiveSource(id: DownloadSourceId): void {
  if (id === "auto") autoState = null;
  // 同步更新设置缓存，等待写盘的调用方也能立即读到新值
  void updateSettings({ downloadSource: id }).catch(() => undefined);
}

export function getActiveSource(): DownloadSourceId {
  return getSettings().downloadSource;
}
