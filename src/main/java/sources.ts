// JDK 下载源的门面：探测三个源、自动挑最快的、按源分发「列版本 / 安装」。
// 三个源：
//   bellsoft → https://api.bell-sw.com/v1/liberica/releases（现有实现，走 liberica.ts）
//   adoptium → https://api.adoptium.net/v3/assets/latest/...（官方 GitHub 下载）
//   tuna     → 清华 TUNA 镜像，用同一份 Adoptium 清单，只换下载地址
// 设置项 settings.javaDownloadSource："auto" 时每次按探测结果挑最快的，全失败回退 bellsoft。
import type { InstalledJava, JavaRelease, JavaSourceId, JavaSourceProbe } from "../../shared/types";
import { fetchText } from "../core/http";
import { logger } from "../core/logger";
import { getSettings } from "../core/settings";
import { ADOPTIUM_MAJORS, install as installAdoptium, listReleases as listAdoptium } from "./adoptium";
import { install as installLiberica, listReleases as listLiberica } from "./liberica";
import type { ManagedSource } from "./vendor";
import { mt } from "../core/i18n";

const log = logger("java/sources");

/** 探测超时：5 秒拿不到就当这个源不可用。 */
const PROBE_TIMEOUT_MS = 5000;

interface ProbeTarget {
  source: ManagedSource;
  label: string;
  url: string;
}

const PROBES: ProbeTarget[] = [
  {
    source: "bellsoft",
    label: "BellSoft Liberica",
    // arch=x86 是 BellSoft API 对 64 位的写法（与 liberica.ts 里的清单请求一致）
    url:
      "https://api.bell-sw.com/v1/liberica/releases?version-feature=21&os=windows&arch=x86&package-type=zip&bundle-type=jdk&bitness=64&output=json",
  },
  { source: "adoptium", label: "Adoptium Temurin", url: "https://api.adoptium.net/v3/info/available_releases" },
  { source: "tuna", get label() {
      return mt("java.source.tuna");
    }, url: "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/" },
];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单次 GET 的耗时；失败返回 null（探测不抛错，界面要看到「哪个源不行」）。 */
async function timedGet(url: string): Promise<number | null> {
  const started = Date.now();
  try {
    await fetchText(url, { allowMirror: false, timeoutMs: PROBE_TIMEOUT_MS, retries: 1 });
    return Date.now() - started;
  } catch (err) {
    log.warn("JDK 源探测失败：" + url + " · " + messageOf(err));
    return null;
  }
}

/** 每个源测两次取较小耗时：第一次通常含 DNS/TLS 握手，不代表真实速度。 */
async function probeOne(target: ProbeTarget): Promise<JavaSourceProbe> {
  const first = await timedGet(target.url);
  const second = await timedGet(target.url);
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

/** 三个源的探测结果（并发；每个源内部两次往返）。 */
export async function probeJavaSources(): Promise<JavaSourceProbe[]> {
  return Promise.all(PROBES.map((target) => probeOne(target)));
}

/** 决定这次用哪个源：设置里写死就用它，auto 就挑探测最快且可用的，全失败回退 bellsoft。 */
export async function pickSource(): Promise<ManagedSource> {
  const wanted = getSettings().javaDownloadSource;
  if (wanted !== "auto") return wanted;
  const probes = await probeJavaSources();
  const usable = probes
    .filter((probe) => probe.ok && probe.latencyMs !== null)
    .sort((a, b) => Number(a.latencyMs) - Number(b.latencyMs));
  const picked: ManagedSource = usable[0]?.source ?? "bellsoft";
  log.info(
    "自动选择 JDK 下载源：" +
      picked +
      (usable.length > 0
        ? "（" + usable.map((probe) => probe.source + "=" + probe.latencyMs + "ms").join(", ") + "）"
        : "（三个源都探测失败，回退 bellsoft）"),
  );
  return picked;
}

/** 列出某源的可用版本；source 缺省取设置，"auto" 会先挑源。 */
export async function listJavaReleases(source?: JavaSourceId): Promise<JavaRelease[]> {
  const wanted = source ?? getSettings().javaDownloadSource;
  const resolved: ManagedSource = wanted === "auto" ? await pickSource() : wanted;
  if (resolved === "bellsoft") return listLiberica();
  return listAdoptium(ADOPTIUM_MAJORS, resolved);
}

/** 按源安装：bellsoft 走现有 Liberica 实现，adoptium/tuna 走 Adoptium 实现。 */
export async function installJavaFrom(
  major: number,
  version?: string,
  source?: JavaSourceId,
  signal?: AbortSignal,
): Promise<InstalledJava> {
  const wanted = source ?? getSettings().javaDownloadSource;
  const resolved: ManagedSource = wanted === "auto" ? await pickSource() : wanted;
  log.info("安装 JDK " + major + " 使用源：" + resolved);
  return resolved === "bellsoft"
    ? installLiberica(major, version, signal)
    : installAdoptium(major, version, resolved, signal);
}
