import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { createTask, type TaskHandle } from "../core/events";
import { downloadFile, downloadMany } from "../core/http";
import { logger } from "../core/logger";
import { getPaths, versionDir, type LauncherPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { resolveJavaExeForMc } from "../java/locate";
import { mavenPathOf, rulesAllow } from "../minecraft/args";
import { clearVersionCache } from "../minecraft/manifest";
import { mt } from "../core/i18n";

const log = logger("loaders/installer");

/** 老版本 version json 没有 downloads 字段，只能按默认 maven 拼地址。 */
const DEFAULT_LIBRARIES_BASE = "https://libraries.minecraft.net/";
const FORGE_MAVEN = "https://maven.minecraftforge.net/";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/";

/** 只有 Maven 坐标时按 group 猜仓库：Forge/NeoForge 的 jar 不在 libraries.minecraft.net。 */
function guessMavenBase(group: string): string {
  if (group === "net.neoforged" || group.startsWith("net.neoforged.")) return NEOFORGE_MAVEN;
  if (
    group === "net.minecraftforge" || group.startsWith("net.minecraftforge.")
    || group === "cpw.mods" || group.startsWith("cpw.mods.")
    || group === "de.oceanlabs.mcp" || group.startsWith("de.oceanlabs.mcp.")
    || group === "trove"
  ) {
    return FORGE_MAVEN;
  }
  return DEFAULT_LIBRARIES_BASE;
}
/** 安装器要跑 processor（下载原版 jar、binpatch 等），给足 10 分钟。 */
const INSTALLER_TIMEOUT_MS = 10 * 60 * 1000;

export interface LibraryItem {
  url: string;
  dest: string;
  sha1?: string;
  size?: number;
}

export interface InstallerJob {
  mcVersion: string;
  /** 目标版本 id（versions/<id>/<id>.json） */
  versionId: string;
  installerUrl: string;
  installerFileName: string;
  installerSha1?: string;
  /** 官方 maven 不可达时改写地址（NeoForge 走 BMCLAPI） */
  mapUrl?: (url: string) => string;
  /** 传给安装器的 --mirror（安装器自己发起的下载也走镜像） */
  mirrorUrl?: string;
  label: string;
}

export interface InstallerOutcome {
  versionId: string;
  installerPath: string;
  /** 是否真的执行了 java -jar installer */
  ranInstaller: boolean;
  /** 是否成功自解析出 install_profile + 版本描述 */
  selfExtracted: boolean;
  warnings: string[];
}

interface InstallProfile {
  spec?: number;
  version?: string;
  minecraft?: string;
  /** "/version.json" 或内联 JSON 字符串 */
  json?: unknown;
  path?: string;
  libraries?: unknown[];
  processors?: unknown[];
  data?: Record<string, { client?: string; server?: string }>;
  versionInfo?: unknown;
}

function fail(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 收集 json.libraries 中客户端需要下载的 artifact（natives 由原版安装负责）。 */
export function collectLibraryItems(json: unknown, mapUrl: (url: string) => string = (u) => u): LibraryItem[] {
  const paths = getPaths();
  const items: LibraryItem[] = [];
  const seen = new Set<string>();
  const libraries = Array.isArray((json as { libraries?: unknown[] } | undefined)?.libraries)
    ? ((json as { libraries: any[] }).libraries)
    : [];

  for (const lib of libraries) {
    if (!rulesAllow(lib?.rules)) continue;
    const artifact = lib?.downloads?.artifact;
    if (artifact?.path && artifact?.url) {
      const dest = join(paths.libraries, String(artifact.path));
      if (seen.has(dest)) continue;
      seen.add(dest);
      items.push({
        url: mapUrl(String(artifact.url)),
        dest,
        sha1: typeof artifact.sha1 === "string" ? artifact.sha1 : undefined,
        size: typeof artifact.size === "number" ? artifact.size : undefined,
      });
      continue;
    }
    if (typeof lib?.name !== "string" || lib.name.length === 0) continue;
    const rel = mavenPathOf(lib.name);
    const dest = join(paths.libraries, rel);
    if (seen.has(dest)) continue;
    seen.add(dest);
    const group = String(lib.name).split(":")[0] ?? "";
    const base = typeof lib.url === "string" && lib.url.length > 0 ? lib.url : guessMavenBase(group);
    const sha1 = lib.checksums?.sha1 ?? lib.sha1;
    items.push({
      url: mapUrl(base.endsWith("/") ? base + rel : `${base}/${rel}`),
      dest,
      sha1: typeof sha1 === "string" ? sha1 : undefined,
      size: typeof lib.size === "number" ? lib.size : undefined,
    });
  }
  return items;
}

export async function downloadLibraries(
  items: LibraryItem[],
  opts: { task?: TaskHandle; label: string; signal?: AbortSignal },
): Promise<{ failed: { url: string; dest: string; error: string }[] }> {
  if (items.length === 0) return { failed: [] };
  const settings = getSettings();
  return downloadMany(items, {
    task: opts.task,
    concurrent: settings.concurrentDownloads,
    connections: settings.connectionsPerFile,
    label: opts.label,
    signal: opts.signal,
  });
}

export async function writeVersionJson(versionId: string, json: unknown): Promise<void> {
  const dir = versionDir(versionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${versionId}.json`), JSON.stringify(json, null, 2), "utf8");
  log.info(`已写入 ${versionId}.json`);
}

/** 统一修正 id / inheritsFrom，加载器 json 只描述差异。 */
export function prepareVersionJson(raw: unknown, job: Pick<InstallerJob, "versionId" | "mcVersion">): any {
  const json = JSON.parse(JSON.stringify(raw ?? {})) as any;
  json.id = job.versionId;
  if (!json.inheritsFrom) json.inheritsFrom = job.mcVersion;
  if (!json.type) json.type = "release";
  delete json._comment;
  if (!json.arguments && !json.minecraftArguments) json.arguments = { game: [], jvm: [] };
  return json;
}

/** 从安装器 jar 里取 install_profile + 版本描述，install_profile.json 缺失即解析失败。 */
export function readInstaller(installerPath: string): { profile: InstallProfile; versionJson: any } {
  const zip = new AdmZip(installerPath);
  const profileEntry = zip.getEntry("install_profile.json");
  if (!profileEntry) throw new Error(mt("loader.noInstallProfile"));
  const profile = JSON.parse(profileEntry.getData().toString("utf8")) as InstallProfile;

  const readEntryJson = (name: string): any => {
    const entry = zip.getEntry(name) ?? zip.getEntry("version.json");
    if (!entry) return undefined;
    return JSON.parse(entry.getData().toString("utf8"));
  };

  let versionJson: any;
  const ref = typeof profile.json === "string" ? profile.json.trim() : "";
  if (ref.startsWith("{") || ref.startsWith("[")) {
    versionJson = JSON.parse(ref);
  } else if (ref.length > 0) {
    versionJson = readEntryJson(ref.replace(/^\/+/, ""));
  }
  if (!versionJson && profile.versionInfo) versionJson = profile.versionInfo;
  if (!versionJson) versionJson = readEntryJson("version.json");
  if (!versionJson) throw new Error(mt("loader.noVersionJson"));

  return { profile, versionJson };
}

/** 安装器跑完后把它写的版本目录按启动器约定改名/改写。 */
async function adoptInstallerOutput(producedId: string, job: InstallerJob): Promise<boolean> {
  const producedDir = versionDir(producedId);
  const producedJsonPath = join(producedDir, `${producedId}.json`);
  if (!existsSync(producedJsonPath)) return false;
  const raw = JSON.parse(await readFile(producedJsonPath, "utf8")) as unknown;
  await writeVersionJson(job.versionId, prepareVersionJson(raw, job));

  if (producedId !== job.versionId) {
    // legacy 版本安装器会额外放客户端 jar；NeoForge 这类只写 json 的目录可以清掉
    const producedJar = join(producedDir, `${producedId}.jar`);
    const targetJar = join(versionDir(job.versionId), `${job.versionId}.jar`);
    if (existsSync(producedJar) && !existsSync(targetJar)) {
      await mkdir(versionDir(job.versionId), { recursive: true });
      await rename(producedJar, targetJar);
    }
    const leftover = await readdir(producedDir).catch(() => [] as string[]);
    const onlyJson = leftover.every((name) => name === `${producedId}.json`);
    if (onlyJson) await rm(producedDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}

/**
 * 安装器的目标目录 = Minecraft 游戏目录：安装器会把 versions/ 和 libraries/ 写到这里，
 * launcher_profiles.json 也必须在这里。core 引入 gameRoot（<root>\.minecraft）后
 * versions/ 会迁到它下面，两者本来一致；万一还没迁，则以 versions/ 的实际位置为准。
 */
export function gameDirOf(paths: LauncherPaths & { gameRoot?: string }): string {
  const versionsHome = dirname(paths.versions);
  const declared = paths.gameRoot;
  if (declared && resolve(versionsHome).toLowerCase().startsWith(resolve(declared).toLowerCase())) return declared;
  return versionsHome;
}

/** Forge/NeoForge 安装器拿 launcher_profiles.json 判断"这里是不是 Minecraft 目录"。 */
async function ensureLauncherProfile(gameDir: string): Promise<void> {
  const file = join(gameDir, "launcher_profiles.json");
  if (existsSync(file)) return;
  await mkdir(gameDir, { recursive: true });
  await writeFile(file, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), "utf8");
  log.info(`已创建 launcher_profiles.json（安装器前置要求）：${file}`);
}

/** 执行 java -jar installer --installClient <root>，日志落 logs/。 */
function runInstallerJar(
  installerPath: string,
  root: string,
  tag: string,
  javaExe: string,
  mirrorUrl?: string,
): Promise<void> {
  const logPath = join(getPaths().logs, `installer-${tag.replace(/[\\/:*?"<>|]/g, "_")}.log`);
  const args = ["-Dfile.encoding=UTF-8", "-jar", installerPath, "--installClient", root];
  if (mirrorUrl) args.push("--mirror", mirrorUrl);
  appendFileSync(logPath, `# ${new Date().toISOString()} ${javaExe} ${args.join(" ")}\n`, "utf8");

  return new Promise<void>((resolve, reject) => {
    let captured = "";
    let settled = false;
    const child = spawn(javaExe, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(mt("loader.installerTimeout", { minutes: INSTALLER_TIMEOUT_MS / 60000, path: installerPath })));
    }, INSTALLER_TIMEOUT_MS);

    const absorb = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      captured = (captured + text).slice(-8000);
      try {
        appendFileSync(logPath, text, "utf8");
      } catch {
        /* 日志写失败不影响安装 */
      }
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (err) => finish(fail(err)));
    child.on("close", (code) => {
      const tail = captured.trim().split(/\r?\n/).slice(-12).join("\n");
      if (code === 0) {
        log.info(`安装器执行完成：${tag}`);
        finish();
      } else {
        finish(new Error(mt("loader.installerExitCode", { code: code === null ? "null" : code, tail })));
      }
    });
  });
}

/**
 * 下载安装器 → 自解析 install_profile/version.json 并下载 libraries → 写版本描述；
 * 有 processors（现代 Forge/NeoForge）或自解析失败时再执行一次安装器补齐 patched 产物。
 */
export async function installFromInstaller(job: InstallerJob, signal?: AbortSignal): Promise<InstallerOutcome> {
  const paths = getPaths();
  const mapUrl = job.mapUrl ?? ((u: string) => u);
  const warnings: string[] = [];
  const task = createTask("loader", job.label);

  try {
    await mkdir(paths.downloads, { recursive: true });
    await mkdir(paths.libraries, { recursive: true });
    await mkdir(paths.logs, { recursive: true });

    task.update({ stage: mt("loader.stage.downloadInstaller"), percent: 0 });
    const installerPath = join(paths.downloads, job.installerFileName);
    await downloadFile(job.installerUrl, installerPath, {
      task,
      expectedSha1: job.installerSha1,
      label: job.installerFileName,
      signal,
    });
    log.info(`安装器就绪：${installerPath}`);

    let profile: InstallProfile | undefined;
    let versionJson: any;
    try {
      const parsed = readInstaller(installerPath);
      profile = parsed.profile;
      versionJson = parsed.versionJson;
    } catch (err) {
      warnings.push(mt("loader.installerParseFailed", { error: fail(err).message }));
      log.warn(warnings[warnings.length - 1]);
    }

    if (profile && versionJson) {
      const profileMc = profile.minecraft ? String(profile.minecraft) : "";
      if (profileMc && profileMc !== job.mcVersion) {
        warnings.push(mt("loader.installerMcMismatch", { actual: profileMc, wanted: job.mcVersion }));
      }
      task.update({ stage: mt("loader.stage.writeVersion") });
      await writeVersionJson(job.versionId, prepareVersionJson(versionJson, job));

      task.update({ stage: mt("loader.stage.libraries") });
      const items = [...collectLibraryItems(versionJson, mapUrl), ...collectLibraryItems(profile, mapUrl)];
      const { failed } = await downloadLibraries(items, { task, label: job.label, signal });
      if (failed.length > 0) {
        warnings.push(mt("loader.librariesFailed", { loader: job.label, count: failed.length, url: failed[0].url, error: failed[0].error }));
      }
    }

    // 自解析只保证"能下载到的库 + 版本描述"；legacy Forge 的 versions/<id>/<id>.jar
    // 与现代 Forge/NeoForge 的 processor 产物都必须由安装器落地，所以总是尽力跑一次。
    let ranInstaller = false;
    {
      try {
        const javaExe = await resolveJavaExeForMc(job.mcVersion);
        const gameDir = gameDirOf(paths);
        log.info(`安装器目标目录（Minecraft 游戏目录）：${gameDir}`);
        await ensureLauncherProfile(gameDir);
        task.update({ stage: mt("loader.stage.runInstaller"), percent: null });
        await runInstallerJar(installerPath, gameDir, job.versionId, javaExe, job.mirrorUrl);
        ranInstaller = true;
        const producedId = profile?.version ? String(profile.version) : job.versionId;
        if (!(await adoptInstallerOutput(producedId, job))) {
          warnings.push(mt("loader.installerNoVersionJson"));
        }
      } catch (err) {
        // 取消要直接上抛，不能当成"安装器执行失败"继续往下走
        if (signal?.aborted) throw err;
        warnings.push(mt("loader.installerFailedFallback", { error: fail(err).message }));
        log.warn(warnings[warnings.length - 1]);
      }
    }

    if (!versionJson && !ranInstaller) {
      throw new Error(mt("loader.installerFailed", { label: job.label }));
    }

    clearVersionCache();
    task.done({ versionId: job.versionId, ranInstaller, warnings });
    return { versionId: job.versionId, installerPath, ranInstaller, selfExtracted: Boolean(versionJson), warnings };
  } catch (err) {
    task.fail(err);
    throw fail(err);
  }
}
