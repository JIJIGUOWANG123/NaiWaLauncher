import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { logger } from "./logger";
import { mt } from "./i18n";

export interface LauncherPaths {
  root: string;
  /** 标准 Minecraft 游戏目录（root\\.minecraft）：versions/libraries/assets/instances */
  gameRoot: string;
  /** 启动器自身数据目录（root\\NaiWa）：config/logs/meta/downloads/java */
  dataRoot: string;
  versions: string;
  libraries: string;
  assets: string;
  assetIndexes: string;
  assetObjects: string;
  java: string;
  instances: string;
  meta: string;
  downloads: string;
  logs: string;
  config: string;
  settingsFile: string;
}

interface Note {
  level: "info" | "warn";
  text: string;
}

let current: LauncherPaths | null = null;
/** 迁移在进程内只做一次，保证 ensureDirs 重试幂等。 */
let migrationDone = false;

function build(rootDir: string): LauncherPaths {
  const root = resolve(rootDir);
  const gameRoot = join(root, ".minecraft");
  const dataRoot = join(root, "NaiWa");
  const assets = join(gameRoot, "assets");
  const config = join(dataRoot, "config");
  return {
    root,
    gameRoot,
    dataRoot,
    versions: join(gameRoot, "versions"),
    libraries: join(gameRoot, "libraries"),
    assets,
    assetIndexes: join(assets, "indexes"),
    assetObjects: join(assets, "objects"),
    java: join(dataRoot, "java"),
    instances: join(gameRoot, "instances"),
    meta: join(dataRoot, "meta"),
    downloads: join(dataRoot, "downloads"),
    logs: join(dataRoot, "logs"),
    config,
    settingsFile: join(config, "settings.json"),
  };
}

export function initPaths(rootDir: string): LauncherPaths {
  if (!rootDir || !rootDir.trim()) throw new Error(mt("core.rootRequired"));
  current = build(rootDir);
  // 换了根目录要允许重新迁移（正常启动只会 init 一次）
  migrationDone = false;
  return current;
}

export function getPaths(): LauncherPaths {
  if (!current) throw new Error("paths not initialised");
  return current;
}

/** 旧版扁平布局 → 新布局的迁移清单。 */
function legacyMoves(p: LauncherPaths): { from: string; to: string }[] {
  return [
    { from: join(p.root, "versions"), to: p.versions },
    { from: join(p.root, "libraries"), to: p.libraries },
    { from: join(p.root, "assets"), to: p.assets },
    { from: join(p.root, "instances"), to: p.instances },
    { from: join(p.root, "launcher_profiles.json"), to: join(p.gameRoot, "launcher_profiles.json") },
    { from: join(p.root, "config"), to: p.config },
    { from: join(p.root, "logs"), to: p.logs },
    { from: join(p.root, "meta"), to: p.meta },
    { from: join(p.root, "downloads"), to: p.downloads },
    { from: join(p.root, "java"), to: p.java },
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 同名不做覆盖：给旧文件找一个 .legacy-N 新名字。 */
async function freeName(target: string): Promise<string> {
  for (let index = 1; index <= 99; index += 1) {
    const candidate = `${target}.legacy-${index}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${target}.legacy-${Date.now()}`;
}

/**
 * 把旧位置搬到新位置。
 * - 新位置不存在：整体 rename（同盘是元数据操作，瞬间完成）
 * - 两边都是目录：逐个搬子项；同名文件改成 .legacy-N 保留，同名目录跳过（不合并用户数据）
 * - 跨盘 rename 会抛 EXDEV：由调用方记 warn 提示手动移动
 */
async function moveEntry(from: string, to: string, notes: Note[]): Promise<"renamed" | "merged" | "partial" | "skipped"> {
  if (!(await exists(to))) {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return "renamed";
  }

  const source = await lstat(from);
  const target = await lstat(to);
  if (!source.isDirectory() || !target.isDirectory()) return "skipped";

  let moved = false;
  for (const name of await readdir(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (await exists(dst)) {
      const srcStat = await lstat(src);
      const dstStat = await lstat(dst);
      if (srcStat.isDirectory() || dstStat.isDirectory()) continue;
      const alt = await freeName(dst);
      await rename(src, alt);
      moved = true;
      notes.push({ level: "warn", text: mt("core.migrationExisting", { dst, alt }) });
      continue;
    }
    await rename(src, dst);
    moved = true;
  }

  // 旧目录清空后才删，避免误删没能搬走的内容
  if ((await readdir(from)).length === 0) {
    await rm(from, { recursive: true, force: true });
    return moved ? "merged" : "renamed";
  }
  return moved ? "partial" : "skipped";
}

/** 旧布局迁移；幂等（旧位置消失后自然无事可做）。 */
export async function migrateLegacyLayout(): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;
  const p = getPaths();
  if (resolve(p.gameRoot) === resolve(p.root) || resolve(p.dataRoot) === resolve(p.root)) return;

  const notes: Note[] = [];
  for (const { from, to } of legacyMoves(p)) {
    if (resolve(from) === resolve(to)) continue;
    if (!(await exists(from))) continue;
    try {
      const action = await moveEntry(from, to, notes);
      if (action === "skipped") {
        notes.push({ level: "warn", text: mt("core.migrationSkipped", { from, to }) });
      } else if (action === "partial") {
        notes.push({ level: "warn", text: mt("core.migrationIncomplete", { from, to }) });
      } else {
        notes.push({ level: "info", text: mt("core.migrationDone", { from, to, action: action === "merged" ? mt("core.migrationMerge") : mt("core.migrationMove") }) });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      notes.push({ level: "warn", text: mt("core.migrationFailed", { from, to, reason }) });
    }
  }

  // 日志在迁移全部结束后才写：否则迁移过程中写日志会提前建出 NaiWa\logs 让整体 rename 退化成合并
  const log = logger("paths");
  for (const note of notes) {
    if (note.level === "warn") log.warn(note.text);
    else log.info(note.text);
  }
}

/** 建立完整目录布局；先迁移旧布局，再建目录。 */
export async function ensureDirs(): Promise<void> {
  const p = getPaths();
  await migrateLegacyLayout();
  const dirs = [
    p.root,
    p.gameRoot,
    p.versions,
    p.libraries,
    p.assetIndexes,
    p.assetObjects,
    join(p.assets, "log_configs"),
    p.instances,
    p.dataRoot,
    p.config,
    p.logs,
    p.meta,
    p.downloads,
    p.java,
  ];
  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

export function versionDir(versionId: string): string {
  return join(getPaths().versions, versionId);
}

export function instanceDir(instanceId: string): string {
  return join(getPaths().instances, instanceId);
}

export function instanceModsDir(instanceId: string): string {
  return join(instanceDir(instanceId), "mods");
}
