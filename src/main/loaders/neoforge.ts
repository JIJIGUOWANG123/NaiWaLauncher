import type { LoaderVersionInfo } from "../../shared/types";
import { fetchText } from "../core/http";
import { logger } from "../core/logger";
import { installFromInstaller } from "./installer-runner";
import { mt } from "../core/i18n";

const log = logger("loaders/neoforge");

/** maven.neoforged.net 在本机不可达，metadata 与 artifact 一律走 BMCLAPI 镜像。 */
const MIRROR_MAVEN = "https://bmclapi2.bangbang93.com/maven";
const METADATA_URL = MIRROR_MAVEN + "/net/neoforged/neoforge/maven-metadata.xml";

/** 官方 neoforged maven 的地址全部改写到镜像。 */
export function mirrorUrl(url: string): string {
  if (!url.includes("//maven.neoforged.net/")) return url;
  return url.replace(/^https?:\/\/maven\.neoforged\.net\/(?:releases|repository|maven)\/?/, MIRROR_MAVEN + "/");
}

function compareLoaderDesc(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * NeoForge 版本号与 Minecraft 的对应规则：
 * - 1.20.1 是唯一的旧命名（当时沿用 Forge 的 47.x），前缀 "1.20.1-47."
 * - 1.20.2 起版本号 = <minor>.<patch>.x，例如 1.20.4 → 20.4.x、1.21.1 → 21.1.x、1.21 → 21.0.x
 * - 新版 Minecraft 26.x 同理：26.3 → 26.3.x
 */
export function neoVersionPrefix(mcVersion: string): string {
  const clean = mcVersion.trim();
  if (clean === "1.20.1") return "1.20.1-47.";
  const parts = clean.split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (major === 1) return minor + "." + patch + ".";
  return major + "." + minor + ".";
}

async function fetchAllVersions(): Promise<string[]> {
  const xml = await fetchText(METADATA_URL, { allowMirror: false });
  const out: string[] = [];
  for (const match of xml.matchAll(/<version>([^<]+)<\/version>/g)) out.push(match[1].trim());
  if (out.length === 0) throw new Error(mt("loader.noMetadata", { loader: "NeoForge" }));
  return out;
}

function isStable(version: string): boolean {
  return !/-(beta|alpha)/i.test(version) && !version.includes("+snapshot");
}

export async function listNeoForgeLoaders(mcVersion: string): Promise<LoaderVersionInfo[]> {
  const prefix = neoVersionPrefix(mcVersion);
  const matched = (await fetchAllVersions()).filter((v) => v.startsWith(prefix));
  if (matched.length === 0) {
    throw new Error(mt("loader.noMatch", { loader: "NeoForge", mc: mcVersion, prefix }));
  }
  return matched
    .sort((a, b) => {
      const sa = isStable(a) ? 0 : 1;
      const sb = isStable(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return compareLoaderDesc(a, b);
    })
    .map((version) => ({ loader: "neoforge" as const, version, mcVersion, stable: isStable(version) }));
}

export async function installNeoForgeLoader(
  mcVersion: string,
  loaderVersion?: string,
  signal?: AbortSignal,
): Promise<{ versionId: string; loaderVersion: string }> {
  let wanted = loaderVersion?.trim();
  if (!wanted) {
    const list = await listNeoForgeLoaders(mcVersion);
    wanted = list[0]?.version;
  }
  if (!wanted) throw new Error(mt("loader.noVersion", { loader: "NeoForge", mc: mcVersion }));

  const installerUrl = MIRROR_MAVEN + "/net/neoforged/neoforge/" + wanted + "/neoforge-" + wanted + "-installer.jar";
  // 启动器内部约定 <mc>-neoforge；安装器自己会写成 neoforge-<version>
  const versionId = mcVersion + "-neoforge";

  log.info("安装 NeoForge " + wanted + "（" + mcVersion + "）");
  const outcome = await installFromInstaller(
    {
      mcVersion,
      versionId,
      installerUrl,
      installerFileName: "neoforge-" + wanted + "-installer.jar",
      mapUrl: mirrorUrl,
      mirrorUrl: MIRROR_MAVEN + "/",
      label: "NeoForge " + wanted,
    },
    signal,
  );
  for (const warning of outcome.warnings) log.warn(warning);
  return { versionId, loaderVersion: wanted };
}
