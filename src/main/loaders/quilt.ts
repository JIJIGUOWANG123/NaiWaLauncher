import type { LoaderVersionInfo } from "../../shared/types";
import { createTask } from "../core/events";
import { fetchJson, fetchText } from "../core/http";
import { logger } from "../core/logger";
import { mavenPathOf } from "../minecraft/args";
import { join } from "node:path";
import {
  collectLibraryItems,
  downloadLibraries,
  writeVersionJson,
  type LibraryItem,
} from "./installer-runner";
import { mt } from "../core/i18n";

const log = logger("loaders/quilt");

const META = "https://meta.quiltmc.org/v3";
const MAVEN = "https://maven.quiltmc.org/repository/release/";
const FABRIC_MAVEN = "https://maven.fabricmc.net/";
const KNOT_CLIENT = "org.quiltmc.loader.impl.launch.knot.KnotClient";
/** Quilt 没有 stable 布尔字段，只能按版本号里的预发布标记判断 */
const UNSTABLE = /-(?:beta|alpha|rc|pre|snapshot)/i;

interface QuiltArtifact {
  version: string;
  maven?: string;
  hashes?: { sha1?: string };
}

interface QuiltLoaderEntry {
  loader: QuiltArtifact;
  hashed?: QuiltArtifact;
  intermediary?: QuiltArtifact;
  launcherMeta?: { libraries?: { common?: any[]; client?: any[] } };
}

function isStable(version: string): boolean {
  return !UNSTABLE.test(version);
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

async function fetchLoaderEntries(mcVersion: string): Promise<QuiltLoaderEntry[]> {
  try {
    return await fetchJson<QuiltLoaderEntry[]>(`${META}/versions/loader/${mcVersion}`, { allowMirror: false });
  } catch (err) {
    throw new Error(mt("loader.noList", { loader: "Quilt", mc: mcVersion, error: (err as Error).message }));
  }
}

/** 稳定版优先，同档按版本号降序。 */
function sortEntries(entries: QuiltLoaderEntry[]): QuiltLoaderEntry[] {
  return [...entries].sort((a, b) => {
    const sa = isStable(a.loader.version) ? 0 : 1;
    const sb = isStable(b.loader.version) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return compareLoaderDesc(a.loader.version, b.loader.version);
  });
}

export async function listQuiltLoaders(mcVersion: string): Promise<LoaderVersionInfo[]> {
  const entries = sortEntries(await fetchLoaderEntries(mcVersion));
  return entries.map((e) => ({
    loader: "quilt" as const,
    version: e.loader.version,
    mcVersion,
    stable: isStable(e.loader.version),
  }));
}

/** maven 的 .sha1 校验文件；部分条目没有，失败即放弃校验。 */
async function sha1At(base: string, rel: string): Promise<string | undefined> {
  const root = base.endsWith("/") ? base : `${base}/`;
  try {
    const text = (await fetchText(`${root}${rel}.sha1`, { allowMirror: false })).trim();
    const token = text.split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40}$/i.test(token) ? token.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

interface LibSpec {
  name: string;
  url: string;
  sha1?: string;
  size?: number;
}

/** meta 元数据里的 librarie 条目 → version json 的 library 条目（带 sha1）。 */
async function toLibrary(spec: LibSpec): Promise<any> {
  const url = spec.url.endsWith("/") ? spec.url : `${spec.url}/`;
  const sha1 = spec.sha1 ?? (await sha1At(url, mavenPathOf(spec.name)));
  return { name: spec.name, url, ...(sha1 ? { sha1 } : {}), ...(spec.size ? { size: spec.size } : {}) };
}

function artifactKey(name: string): string {
  const parts = name.split(":");
  return `${parts[0] ?? ""}:${parts[1] ?? ""}`;
}

/**
 * Quilt 的 profile json 已给出完整库清单（asm/mixin/quilt-loader/hashed/intermediary），
 * 优先照搬；拿不到时退回 launcherMeta.libraries + 三个必需坐标。
 */
async function buildLibraries(entry: QuiltLoaderEntry, profile: any, mcVersion: string): Promise<any[]> {
  const pool: any[] = Array.isArray(profile?.libraries) && profile.libraries.length > 0
    ? profile.libraries
    : [...(entry.launcherMeta?.libraries?.common ?? []), ...(entry.launcherMeta?.libraries?.client ?? [])];

  const specs: LibSpec[] = [];
  const seen = new Set<string>();
  for (const lib of pool) {
    if (typeof lib?.name !== "string" || lib.name.length === 0 || seen.has(lib.name)) continue;
    seen.add(lib.name);
    specs.push({
      name: lib.name,
      url: typeof lib.url === "string" && lib.url.length > 0 ? lib.url : MAVEN,
      sha1: lib.hashes?.sha1 ?? lib.checksums?.sha1 ?? lib.sha1,
      size: typeof lib.size === "number" ? lib.size : undefined,
    });
  }

  // Quilt 跑起来至少要 quilt-loader、它依赖的 hashed，以及 fabric 的 intermediary
  const mandatory: LibSpec[] = [
    {
      name: `org.quiltmc:quilt-loader:${entry.loader.version}`,
      url: MAVEN,
      sha1: entry.loader.hashes?.sha1,
    },
    {
      name: `org.quiltmc:hashed:${entry.hashed?.version ?? mcVersion}`,
      url: MAVEN,
      sha1: entry.hashed?.hashes?.sha1,
    },
    {
      name: `net.fabricmc:intermediary:${entry.intermediary?.version ?? mcVersion}`,
      url: FABRIC_MAVEN,
      sha1: entry.intermediary?.hashes?.sha1,
    },
  ];
  const present = new Set(specs.map((s) => artifactKey(s.name)));
  for (const spec of mandatory) {
    if (present.has(artifactKey(spec.name))) continue;
    present.add(artifactKey(spec.name));
    specs.push(spec);
  }

  return await Promise.all(specs.map((spec) => toLibrary(spec)));
}

export async function installQuiltLoader(
  mcVersion: string,
  loaderVersion?: string,
  signal?: AbortSignal,
): Promise<{ versionId: string; loaderVersion: string }> {
  const entries = sortEntries(await fetchLoaderEntries(mcVersion));
  const wanted = loaderVersion?.trim();
  const entry = wanted ? entries.find((e) => e.loader.version === wanted) : entries[0];
  if (!entry) {
    throw new Error(mt("loader.noLoader", { loader: "Quilt", mc: mcVersion, version: wanted ?? mt("common.default") }));
  }

  const versionId = `${mcVersion}-quilt`;
  const task = createTask("loader", mt("loader.installTitle", { name: "Quilt", version: entry.loader.version }));
  try {
    task.update({ stage: mt("loader.stage.metadata"), percent: 0 });

    let profile: any | undefined;
    try {
      profile = await fetchJson<any>(
        `${META}/versions/loader/${mcVersion}/${entry.loader.version}/profile/json`,
        { allowMirror: false },
      );
    } catch {
      log.warn("未取到 Quilt profile json，按 launcherMeta 组装库清单");
    }

    const libraries = await buildLibraries(entry, profile, mcVersion);
    const json = {
      id: versionId,
      inheritsFrom: mcVersion,
      type: "release",
      mainClass: typeof profile?.mainClass === "string" ? profile.mainClass : KNOT_CLIENT,
      arguments: profile?.arguments ?? { game: [], jvm: [] },
      libraries,
    };

    task.update({ stage: mt("loader.stage.writeVersion") });
    await writeVersionJson(versionId, json);

    task.update({ stage: mt("loader.stage.libraries") });
    const items: LibraryItem[] = collectLibraryItems(json);
    const { failed } = await downloadLibraries(items, { task, label: `quilt ${entry.loader.version}`, signal });
    if (failed.length > 0) {
      throw new Error(mt("loader.librariesFailed", { loader: "Quilt", count: failed.length, url: failed[0].url, error: failed[0].error }));
    }

    task.done({ versionId, loaderVersion: entry.loader.version, libraries: items.length });
    log.info(`Quilt ${entry.loader.version} 安装完成：${join("versions", versionId)}`);
    return { versionId, loaderVersion: entry.loader.version };
  } catch (err) {
    task.fail(err);
    throw err;
  }
}
