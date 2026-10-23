import type { LoaderVersionInfo } from "../../shared/types";
import { createTask } from "../core/events";
import { fetchJson, fetchText } from "../core/http";
import { logger } from "../core/logger";
import { join } from "node:path";
import {
  collectLibraryItems,
  downloadLibraries,
  writeVersionJson,
  type LibraryItem,
} from "./installer-runner";
import { mt } from "../core/i18n";

const log = logger("loaders/fabric");

const META = "https://meta.fabricmc.net/v2";
const MAVEN = "https://maven.fabricmc.net/";
const KNOT_CLIENT = "net.fabricmc.loader.impl.launch.knot.KnotClient";
/** 1.14 之前的 Fabric 走旧入口，这里只覆盖现代版本 */
const DEFAULT_JVM_ARGS = ["-DFabricMcEmu= net.minecraft.client.main.Main "];

interface FabricLoaderEntry {
  loader: { version: string; stable: boolean; maven?: string };
  intermediary?: { version: string; stable?: boolean };
  launcherMeta?: {
    version?: number;
    min_java_version?: number;
    libraries?: { common?: any[]; client?: any[]; server?: any[] };
  };
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

async function fetchLoaderEntries(mcVersion: string): Promise<FabricLoaderEntry[]> {
  try {
    return await fetchJson<FabricLoaderEntry[]>(`${META}/versions/loader/${mcVersion}`, { allowMirror: false });
  } catch (err) {
    throw new Error(mt("loader.noList", { loader: "Fabric", mc: mcVersion, error: (err as Error).message }));
  }
}

/** 稳定版优先，同档按版本号降序。 */
function sortEntries(entries: FabricLoaderEntry[]): FabricLoaderEntry[] {
  return [...entries].sort((a, b) => {
    const sa = a.loader.stable ? 0 : 1;
    const sb = b.loader.stable ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return compareLoaderDesc(a.loader.version, b.loader.version);
  });
}

export async function listFabricLoaders(mcVersion: string): Promise<LoaderVersionInfo[]> {
  const entries = sortEntries(await fetchLoaderEntries(mcVersion));
  return entries.map((e) => ({
    loader: "fabric" as const,
    version: e.loader.version,
    mcVersion,
    stable: e.loader.stable === true,
  }));
}

async function mavenSha1(relativePath: string): Promise<string | undefined> {
  try {
    const text = (await fetchText(`${MAVEN}${relativePath}.sha1`, { allowMirror: false })).trim();
    return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** 组装 version json 的 libraries：asm 等来自 launcherMeta，loader/intermediary 来自 maven。 */
async function buildLibraries(entry: FabricLoaderEntry, mcVersion: string): Promise<any[]> {
  const meta = entry.launcherMeta?.libraries;
  const pool = [...(meta?.common ?? []), ...(meta?.client ?? [])];
  const libs: any[] = [];
  const seen = new Set<string>();
  for (const lib of pool) {
    if (typeof lib?.name !== "string" || seen.has(lib.name)) continue;
    seen.add(lib.name);
    libs.push({
      name: lib.name,
      url: typeof lib.url === "string" ? lib.url : MAVEN,
      sha1: lib.sha1,
      size: lib.size,
    });
  }

  const loaderPath = `net/fabricmc/fabric-loader/${entry.loader.version}/fabric-loader-${entry.loader.version}.jar`;
  const intermediaryVersion = entry.intermediary?.version ?? mcVersion;
  const intermediaryPath = `net/fabricmc/intermediary/${intermediaryVersion}/intermediary-${intermediaryVersion}.jar`;

  libs.push({
    name: `net.fabricmc:fabric-loader:${entry.loader.version}`,
    url: MAVEN,
    sha1: await mavenSha1(loaderPath),
  });
  libs.push({
    name: `net.fabricmc:intermediary:${intermediaryVersion}`,
    url: MAVEN,
    sha1: await mavenSha1(intermediaryPath),
  });
  return libs;
}

export async function installFabricLoader(
  mcVersion: string,
  loaderVersion?: string,
  signal?: AbortSignal,
): Promise<{ versionId: string; loaderVersion: string }> {
  const entries = sortEntries(await fetchLoaderEntries(mcVersion));
  const wanted = loaderVersion?.trim();
  const entry = wanted
    ? entries.find((e) => e.loader.version === wanted)
    : entries[0];
  if (!entry) {
    throw new Error(mt("loader.noLoader", { loader: "Fabric", mc: mcVersion, version: wanted ?? mt("common.default") }));
  }

  const versionId = `${mcVersion}-fabric`;
  const task = createTask("loader", mt("loader.installTitle", { name: "Fabric", version: entry.loader.version }));
  try {
    task.update({ stage: mt("loader.stage.metadata"), percent: 0 });

    // 官方 profile 提供 arguments/mainClass 等细节；拿不到就退回内置常量
    let profile: any | undefined;
    try {
      profile = await fetchJson<any>(
        `${META}/versions/loader/${mcVersion}/${entry.loader.version}/profile/json`,
        { allowMirror: false },
      );
    } catch {
      log.warn(`未取到 Fabric profile json，使用内置启动参数`);
    }

    const libraries = await buildLibraries(entry, mcVersion);
    const json = {
      id: versionId,
      inheritsFrom: mcVersion,
      type: "release",
      mainClass: typeof profile?.mainClass === "string" ? profile.mainClass : KNOT_CLIENT,
      arguments: profile?.arguments ?? { game: [], jvm: [...DEFAULT_JVM_ARGS] },
      libraries,
    };

    task.update({ stage: mt("loader.stage.writeVersion") });
    await writeVersionJson(versionId, json);

    task.update({ stage: mt("loader.stage.libraries") });
    const items: LibraryItem[] = collectLibraryItems(json);
    const { failed } = await downloadLibraries(items, { task, label: `fabric ${entry.loader.version}`, signal });
    if (failed.length > 0) {
      throw new Error(mt("loader.librariesFailed", { loader: "Fabric", count: failed.length, url: failed[0].url, error: failed[0].error }));
    }

    task.done({ versionId, loaderVersion: entry.loader.version, libraries: items.length });
    log.info(`Fabric ${entry.loader.version} 安装完成：${join("versions", versionId)}`);
    return { versionId, loaderVersion: entry.loader.version };
  } catch (err) {
    task.fail(err);
    throw err;
  }
}
