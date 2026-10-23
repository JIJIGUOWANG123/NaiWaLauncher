import type { LoaderVersionInfo } from "../../shared/types";
import { createTask } from "../core/events";
import { fetchJson, fetchText } from "../core/http";
import { logger } from "../core/logger";
import { getVersionJson } from "../minecraft/manifest";
import { mavenPathOf } from "../minecraft/args";
import { join } from "node:path";
import {
  collectLibraryItems,
  downloadLibraries,
  writeVersionJson,
  type LibraryItem,
} from "./installer-runner";
import { mt } from "../core/i18n";

const log = logger("loaders/liteloader");

/** 官方元数据：{ versions: { "<mc>": { repo, snapshots|artefacts } } } */
const META = "https://dl.liteloader.com/versions/versions.json";
/** jar 的实际下载根：<repo>/com/mumfrey/liteloader/<dir>/<file> */
const JAR_ROOT = "https://dl.liteloader.com/versions/";
const JAR_GROUP_PATH = "com/mumfrey/liteloader";
const LITELOADER_KEY = "com.mumfrey:liteloader";

const MAX_MC = "1.12.2";
const MIN_MC = "1.5.2";
/** LiteLoader 是 launchwrapper 的 tweaker，不是独立 main */
const LAUNCHWRAPPER_MAIN = "net.minecraft.launchwrapper.Launch";
const TWEAKER = "com.mumfrey.liteloader.launch.LiteLoaderTweaker";

const MINECRAFT_LIBS = "https://libraries.minecraft.net/";
const MAVEN_CENTRAL = "https://repo1.maven.org/maven2/";
const SPONGE_MAVEN = "https://repo.spongepowered.org/maven/";

interface LiteLibrarySpec {
  name: string;
  url?: string;
}

interface LiteArtefact {
  tweakClass?: string;
  libraries?: LiteLibrarySpec[];
  stream?: string;
  file: string;
  version: string;
  md5?: string;
  build?: string;
  timestamp?: string;
}

interface LiteRepoGroup {
  artefacts?: LiteArtefact[] | Record<string, LiteArtefact>;
  latest?: LiteArtefact;
}

interface LiteVersionData {
  repo?: { stream?: string; type?: string; url?: string; classifier?: string };
  /** 1.8+ 走 maven 快照仓库 */
  snapshots?: { libraries?: LiteLibrarySpec[] } & Record<string, any>;
  /** 1.5.2–1.8 走 ivy 仓库 */
  artefacts?: Record<string, any>;
}

function compareMc(a: string, b: string): number {
  const pa = a.split(/[._-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[._-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 元数据里没有 1.13+ 的 LiteLoader，与其发一次请求不如直接判空。 */
function supportedCheck(mcVersion: string): { ok: boolean; reason?: string } {
  if (compareMc(mcVersion, MAX_MC) > 0) {
    return { ok: false, reason: mt("loader.liteLoaderMax") };
  }
  if (compareMc(mcVersion, MIN_MC) < 0) {
    return { ok: false, reason: mt("loader.liteLoaderMin", { version: MIN_MC }) };
  }
  return { ok: true };
}

/** 供 index 在安装原版之前就给出可读错误，避免白装一个不支持的原版。 */
export function assertLiteLoaderSupported(mcVersion: string): void {
  const support = supportedCheck(mcVersion);
  if (!support.ok) throw new Error(support.reason ?? mt("loader.unsupportedMc", { loader: "LiteLoader", mc: mcVersion }));
}

async function fetchMeta(): Promise<Record<string, LiteVersionData>> {
  const raw = await fetchJson<{ versions?: Record<string, LiteVersionData> }>(META, { allowMirror: false });
  return raw?.versions ?? {};
}

/** 新版本把构件放在 snapshots 下，老版本放在 artefacts 下，结构相同。 */
function pickGroup(data: LiteVersionData | undefined): LiteRepoGroup | undefined {
  if (!data) return undefined;
  const bucket = (data.snapshots ?? data.artefacts) as Record<string, any> | undefined;
  const group = bucket?.[LITELOADER_KEY] as LiteRepoGroup | undefined;
  return group && typeof group === "object" ? group : undefined;
}

/** latest 在前，其余构件按版本号去重（元数据里以 md5 为键）。 */
function groupArtefacts(group: LiteRepoGroup | undefined): LiteArtefact[] {
  if (!group) return [];
  const out: LiteArtefact[] = [];
  const seen = new Set<string>();
  const push = (entry: LiteArtefact | undefined): void => {
    if (!entry || typeof entry.version !== "string" || typeof entry.file !== "string") return;
    if (seen.has(entry.version)) return;
    seen.add(entry.version);
    out.push(entry);
  };
  push(group.latest);
  const rest = group.artefacts;
  if (Array.isArray(rest)) rest.forEach(push);
  else if (rest && typeof rest === "object") Object.values(rest).forEach(push);
  return out;
}

/** 快照仓库里 jar 的目录名就是文件名去掉 liteloader-/jar 后缀（1.12.2-SNAPSHOT / 1.7.10）。 */
function jarDirOf(entry: LiteArtefact): string {
  return entry.file.replace(/^liteloader-/, "").replace(/\.jar$/i, "");
}

function jarUrlOf(entry: LiteArtefact): string {
  return `${JAR_ROOT}${JAR_GROUP_PATH}/${jarDirOf(entry)}/${entry.file}`;
}

/** 只有 Maven 坐标的库要按 group 找仓库：asm 与 launchwrapper 都不在同一个地址。 */
function mavenBaseOf(spec: LiteLibrarySpec): string {
  if (typeof spec.url === "string" && spec.url.length > 0) return spec.url;
  const group = spec.name.split(":")[0] ?? "";
  if (group === "net.minecraft") return MINECRAFT_LIBS;
  if (group.startsWith("org.spongepowered")) return SPONGE_MAVEN;
  if (group === "org.ow2.asm" || group.startsWith("org.ow2.asm.")) return MAVEN_CENTRAL;
  return MINECRAFT_LIBS;
}

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

export async function listLiteLoaderVersions(mcVersion: string): Promise<LoaderVersionInfo[]> {
  if (!supportedCheck(mcVersion).ok) return [];
  let meta: Record<string, LiteVersionData>;
  try {
    meta = await fetchMeta();
  } catch (err) {
    log.warn("LiteLoader 元数据不可达：" + (err as Error).message);
    return [];
  }
  const entries = groupArtefacts(pickGroup(meta[mcVersion]));
  return entries.map((e) => ({
    loader: "liteloader" as const,
    version: e.version,
    mcVersion,
    stable: true,
  }));
}

/** 目标版本是否为 legacy（minecraftArguments）描述：1.12.2 及更早都是。 */
async function isLegacyParent(mcVersion: string): Promise<boolean> {
  try {
    const json = await getVersionJson(mcVersion);
    return !(Array.isArray(json?.arguments?.game) && json.arguments.game.length > 0);
  } catch {
    return true;
  }
}

export async function installLiteLoader(
  mcVersion: string,
  loaderVersion?: string,
  signal?: AbortSignal,
): Promise<{ versionId: string; loaderVersion: string }> {
  const support = supportedCheck(mcVersion);
  if (!support.ok) throw new Error(support.reason ?? mt("loader.unsupportedMc", { loader: "LiteLoader", mc: mcVersion }));

  const meta = await fetchMeta();
  const group = pickGroup(meta[mcVersion]);
  const entries = groupArtefacts(group);
  const wanted = loaderVersion?.trim();
  const entry = wanted ? entries.find((e) => e.version === wanted) : entries[0];
  if (!entry) {
    throw new Error(
      mt("loader.liteLoaderNoBuild", { mc: mcVersion, what: wanted ? mt("loader.liteLoaderBuildVersion", { version: wanted }) : mt("loader.liteLoaderBuildAny", { key: LITELOADER_KEY }) }),
    );
  }

  const versionId = `${mcVersion}-liteloader`;
  const task = createTask("loader", mt("loader.installTitle", { name: "LiteLoader", version: entry.version }));
  try {
    task.update({ stage: mt("loader.stage.metadata"), percent: 0 });

    const jarUrl = jarUrlOf(entry);
    const jarPath = `${JAR_GROUP_PATH}/${jarDirOf(entry)}/${entry.file}`;
    const libraries: any[] = [
      {
        // 快照仓库的目录名与 maven 版本号并不一致（1.7.10_04 → 1.7.10），因此显式给出路径
        name: `${LITELOADER_KEY}:${entry.version}`,
        downloads: {
          artifact: {
            path: jarPath,
            url: jarUrl,
            ...(await sha1At(JAR_ROOT, jarPath).then((sha1) => (sha1 ? { sha1 } : {}))),
          },
        },
      },
    ];

    const pool: LiteLibrarySpec[] = [
      ...(group && (group as any).libraries ? ((group as any).libraries as LiteLibrarySpec[]) : []),
      ...(Array.isArray(entry.libraries) ? entry.libraries : []),
    ];
    const seen = new Set<string>();
    for (const spec of pool) {
      if (typeof spec?.name !== "string" || spec.name.length === 0 || seen.has(spec.name)) continue;
      seen.add(spec.name);
      const base = mavenBaseOf(spec);
      const sha1 = await sha1At(base, mavenPathOf(spec.name));
      libraries.push({ name: spec.name, url: base, ...(sha1 ? { sha1 } : {}) });
    }

    const tweakClass = typeof entry.tweakClass === "string" && entry.tweakClass.length > 0
      ? entry.tweakClass
      : TWEAKER;
    const legacy = await isLegacyParent(mcVersion);
    const json: any = {
      id: versionId,
      inheritsFrom: mcVersion,
      type: "release",
      mainClass: LAUNCHWRAPPER_MAIN,
      libraries,
    };
    if (legacy) {
      // 合并时子级的 minecraftArguments 排在最前，launchwrapper 不在乎顺序
      json.minecraftArguments = `--tweakClass ${tweakClass}`;
    } else {
      json.arguments = { game: ["--tweakClass", tweakClass], jvm: [] };
    }

    task.update({ stage: mt("loader.stage.writeVersion") });
    await writeVersionJson(versionId, json);

    task.update({ stage: mt("loader.stage.libraries") });
    const items: LibraryItem[] = collectLibraryItems(json);
    const { failed } = await downloadLibraries(items, { task, label: `liteloader ${entry.version}`, signal });
    if (failed.length > 0) {
      throw new Error(mt("loader.librariesFailed", { loader: "LiteLoader", count: failed.length, url: failed[0].url, error: failed[0].error }));
    }

    task.done({ versionId, loaderVersion: entry.version, libraries: items.length });
    log.info(`LiteLoader ${entry.version} 安装完成：${join("versions", versionId)}`);
    return { versionId, loaderVersion: entry.version };
  } catch (err) {
    task.fail(err);
    throw err;
  }
}
