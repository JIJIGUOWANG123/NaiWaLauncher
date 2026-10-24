// JDK 下载源的门面：探测所有源、自动挑最快的、按源分发「列版本 / 安装」。
// 六个源：
//   bellsoft  → https://api.bell-sw.com/v1/liberica/releases（现有实现，走 liberica.ts）
//   adoptium  → https://api.adoptium.net/v3/assets/latest/...（官方 GitHub 下载）
//   tuna      → 清华 TUNA 镜像，用同一份 Adoptium 清单，只换下载地址
//   zulu      → d10.injdk.cn/openjdk/zulu/<major>/ 目录列表（injdk.ts）
//   oracle    → d10.injdk.cn/openjdk/oraclejdk/<major>/ 目录列表（injdk.ts）
//   dragonwell→ GitHub Releases 清单 + 阿里云 OSS 下载（dragonwell.ts）
// 设置项 settings.javaDownloadSource："auto" 时每次按探测结果挑最快的，全失败回退 bellsoft。
// Oracle JDK 的许可以「官方再分发限制」著称，镜像上那份只是可选项：探测照样测速显示，
// 但 auto 永远不会挑它（见 pickSource）。
import type { InstalledJava, JavaRelease, JavaSourceId, JavaSourceProbe } from "../../shared/types";
import { fetchText } from "../core/http";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { ADOPTIUM_MAJORS, install as installAdoptium, listReleases as listAdoptium } from "./adoptium";
import { install as installDragonwell, listAllReleases as listDragonwell, probeLatency as dragonwellProbeLatency } from "./dragonwell";
import { install as installInjdk, isInjdkSource, listAllReleases as listInjdk, listingUrl } from "./injdk";
import { install as installLiberica, listReleases as listLiberica } from "./liberica";
import type { ManagedSource } from "./vendor";
import { mt } from "../core/i18n";

const log = logger("java/sources");

/** 探测超时：5 秒拿不到就当这个源不可用。 */
const PROBE_TIMEOUT_MS = 5000;

interface ProbeTarget {
  source: ManagedSource;
  label: string;
  /** 探测地址：拉一次这个页面/接口就当成一次往返。 */
  resolve?: () => Promise<string>;
  /** 自带测速实现（Dragonwell 要读真实 zip 的前 32KB，不能走「整页文本」那条路）。 */
  measure?: () => Promise<number>;
}

const PROBES: ProbeTarget[] = [
  {
    source: "bellsoft",
    label: "BellSoft Liberica",
    // arch=x86 是 BellSoft API 对 64 位的写法（与 liberica.ts 里的清单请求一致）
    resolve: async () =>
      "https://api.bell-sw.com/v1/liberica/releases?version-feature=21&os=windows&arch=x86&package-type=zip&bundle-type=jdk&bitness=64&output=json",
  },
  {
    source: "adoptium",
    label: "Adoptium Temurin",
    resolve: async () => "https://api.adoptium.net/v3/info/available_releases",
  },
  {
    source: "tuna",
    get label() {
      return mt("java.source.tuna");
    },
    resolve: async () => "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/",
  },
  { source: "zulu", label: "Azul Zulu", resolve: async () => listingUrl("zulu", 21) },
  { source: "oracle", label: "Oracle JDK", resolve: async () => listingUrl("oracle", 21) },
  {
    source: "dragonwell",
    label: "Alibaba Dragonwell",
    // 最新版 zip 的前 32KB：和其它源「拉一个页面」同量级，量的也是真实下载 CDN
    measure: () => dragonwellProbeLatency(),
  },
];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单次 GET 的耗时；失败直接抛错，由 timeOnce 收成 null（日志里带真实原因）。 */
async function timedGet(url: string): Promise<number> {
  const started = Date.now();
  await fetchText(url, { allowMirror: false, timeoutMs: PROBE_TIMEOUT_MS, retries: 1 });
  return Date.now() - started;
}

/** 按探测目标给出「一次往返」的动作；统一成 measure 后，两类源的上报口径一致。 */
function measurerOf(target: ProbeTarget): () => Promise<number> {
  if (target.measure) return target.measure;
  return async () => timedGet(await target.resolve!());
}

/** 跑一次探测，把耗时与错误都收成「毫秒或 null」，探测本身绝不抛错。 */
async function timeOnce(source: ManagedSource, measure: () => Promise<number>): Promise<number | null> {
  try {
    return await measure();
  } catch (err) {
    log.warn("JDK 源探测失败：" + source + " · " + messageOf(err));
    return null;
  }
}

/** 每个源测两次取较小耗时：第一次通常含 DNS/TLS 握手，不代表真实速度。 */
async function probeOne(target: ProbeTarget): Promise<JavaSourceProbe> {
  const measure = measurerOf(target);
  const first = await timeOnce(target.source, measure);
  const second = await timeOnce(target.source, measure);
  const okMs = [first, second].filter((ms): ms is number => ms !== null);
  const best = okMs.length > 0 ? Math.min(...okMs) : null;
  return {
    source: target.source,
    label: target.label,
    latencyMs: best,
    ok: best !== null,
    ...(best === null ? { detail: mt("java.sources.unreachable", { ms: PROBE_TIMEOUT_MS }) } : {}),
  };
}

/** 所有源的探测结果（并发；每个源内部两次往返）。 */
export async function probeJavaSources(): Promise<JavaSourceProbe[]> {
  return Promise.all(PROBES.map((target) => probeOne(target)));
}

/**
 * 决定这次用哪个源：设置里写死就用它，auto 就挑探测最快且可用的，全失败回退 bellsoft。
 * Oracle JDK 不参与 auto：它的许可禁止第三方再分发，必须由用户自己显式选。
 */
export async function pickSource(): Promise<ManagedSource> {
  const wanted = getSettings().javaDownloadSource;
  if (wanted !== "auto") return wanted;
  const probes = await probeJavaSources();
  const usable = probes
    .filter((probe) => probe.ok && probe.latencyMs !== null && probe.source !== "oracle")
    .sort((a, b) => Number(a.latencyMs) - Number(b.latencyMs));
  const picked: ManagedSource = usable[0]?.source ?? "bellsoft";
  log.info(
    "自动选择 JDK 下载源：" +
      picked +
      (usable.length > 0
        ? "（" + usable.map((probe) => probe.source + "=" + probe.latencyMs + "ms").join(", ") + "）"
        : "（所有源都探测失败，回退 bellsoft）"),
  );
  return picked;
}

/** 列出某源的可用版本；source 缺省取设置，"auto" 会先挑源。 */
export async function listJavaReleases(source?: JavaSourceId): Promise<JavaRelease[]> {
  const wanted = source ?? getSettings().javaDownloadSource;
  const resolved: ManagedSource = wanted === "auto" ? await pickSource() : wanted;
  if (resolved === "bellsoft") return listLiberica();
  if (isInjdkSource(resolved)) return listInjdk(resolved);
  if (resolved === "dragonwell") return listDragonwell();
  return listAdoptium(ADOPTIUM_MAJORS, resolved);
}

/** 按源安装：bellsoft 走 Liberica，adoptium/tuna 走 Adoptium，zulu/oracle 走 injdk，dragonwell 走 Dragonwell。 */
export async function installJavaFrom(
  major: number,
  version?: string,
  source?: JavaSourceId,
  signal?: AbortSignal,
): Promise<InstalledJava> {
  const wanted = source ?? getSettings().javaDownloadSource;
  const resolved: ManagedSource = wanted === "auto" ? await pickSource() : wanted;
  log.info("安装 JDK " + major + " 使用源：" + resolved);
  if (resolved === "bellsoft") return installLiberica(major, version, signal);
  if (isInjdkSource(resolved)) return installInjdk(major, version, resolved, signal);
  if (resolved === "dragonwell") return installDragonwell(major, version, signal);
  return installAdoptium(major, version, resolved, signal);
}
