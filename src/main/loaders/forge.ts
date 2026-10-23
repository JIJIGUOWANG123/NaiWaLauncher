import type { LoaderVersionInfo } from "../../shared/types";
import { fetchJson, fetchText } from "../core/http";
import { logger } from "../core/logger";
import { installFromInstaller } from "./installer-runner";
import { mt } from "../core/i18n";

const log = logger("loaders/forge");

const PROMOTIONS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const MAVEN = "https://maven.minecraftforge.net";

interface PromotionsFile {
  promos?: Record<string, string>;
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

async function fetchPromotions(mcVersion: string): Promise<{ recommended?: string; latest?: string }> {
  const file = await fetchJson<PromotionsFile>(PROMOTIONS, { allowMirror: false });
  const promos = file.promos ?? {};
  return {
    recommended: promos[mcVersion + "-recommended"],
    latest: promos[mcVersion + "-latest"],
  };
}

/** promotions 只给 recommended/latest，完整版本历史要读 maven-metadata。 */
async function fetchMavenVersions(mcVersion: string): Promise<string[]> {
  try {
    const xml = await fetchText(MAVEN + "/net/minecraftforge/forge/maven-metadata.xml", { allowMirror: false });
    const prefix = mcVersion + "-";
    const out: string[] = [];
    for (const match of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
      const full = match[1].trim();
      if (full.startsWith(prefix)) out.push(full.slice(prefix.length));
    }
    return out;
  } catch (err) {
    log.warn("读取 Forge maven-metadata 失败：" + (err as Error).message);
    return [];
  }
}

export async function listForgeLoaders(mcVersion: string): Promise<LoaderVersionInfo[]> {
  const [promos, maven] = await Promise.all([fetchPromotions(mcVersion), fetchMavenVersions(mcVersion)]);
  const versions = new Set<string>(maven);
  if (promos.recommended) versions.add(promos.recommended);
  if (promos.latest) versions.add(promos.latest);

  const sorted = [...versions].sort(compareLoaderDesc);
  const stableVersion = promos.recommended ?? promos.latest ?? sorted[0];
  return sorted.map((version) => ({
    loader: "forge" as const,
    version,
    mcVersion,
    stable: version === stableVersion,
  }));
}

async function installerSha1(url: string): Promise<string | undefined> {
  try {
    const text = (await fetchText(url + ".sha1", { allowMirror: false })).trim();
    return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function installForgeLoader(
  mcVersion: string,
  loaderVersion?: string,
  signal?: AbortSignal,
): Promise<{ versionId: string; loaderVersion: string }> {
  const promos = await fetchPromotions(mcVersion);
  let wanted = loaderVersion?.trim();
  if (!wanted) wanted = promos.recommended ?? promos.latest;
  if (!wanted) {
    const all = await listForgeLoaders(mcVersion);
    wanted = all[0]?.version;
  }
  if (!wanted) throw new Error(mt("loader.noVersion", { loader: "Forge", mc: mcVersion }));

  const fullVersion = mcVersion + "-" + wanted;
  const installerUrl = MAVEN + "/net/minecraftforge/forge/" + fullVersion + "/forge-" + fullVersion + "-installer.jar";
  const versionId = mcVersion + "-forge-" + wanted;

  log.info("安装 Forge " + wanted + "（" + mcVersion + "）");
  const outcome = await installFromInstaller(
    {
      mcVersion,
      versionId,
      installerUrl,
      installerFileName: "forge-" + fullVersion + "-installer.jar",
      installerSha1: await installerSha1(installerUrl),
      label: "Forge " + wanted,
    },
    signal,
  );
  for (const warning of outcome.warnings) log.warn(warning);
  return { versionId, loaderVersion: wanted };
}
