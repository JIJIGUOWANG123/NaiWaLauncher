// 本地皮肤库 + CustomSkinLoader 落地。
//
// 【CustomSkinLoader 本地皮肤规范】已核对官方源码 xfl03/MCCustomSkinLoader（15-develop 分支）：
//   · 数据目录 <gameDir>/CustomSkinLoader
//     （CustomSkinLoader.java：DATA_DIR = new File(MinecraftUtil.getMinecraftDataDir(), "CustomSkinLoader")）
//   · 配置文件 <gameDir>/CustomSkinLoader/CustomSkinLoader.json（同文件 CONFIG_FILE）
//   · 本地皮肤（LegacyLoader.LocalSkin，路径相对 DATA_DIR）：
//       LocalSkin/skins/{USERNAME}.png
//       LocalSkin/capes/{USERNAME}.png
//       LocalSkin/elytras/{USERNAME}.png
//   · loadlist 里必须有 name = "LocalSkin"、type = "Legacy" 的条目：Config.updateLoadlist() 只更新
//     「配置里已存在的同名条目」，不会补缺失的；全新配置由 initConfig() 用各插件默认 profile 生成（含 LocalSkin）。
//   · 该条目的 model 决定手臂模型（"slim" / "default"；不填时 updateSkinSiteProfile 填 "auto" → 按宽臂渲染）。
//   来源：
//     https://github.com/xfl03/MCCustomSkinLoader/blob/15-develop/Common/src/main/java/customskinloader/loader/LegacyLoader.java
//     https://github.com/xfl03/MCCustomSkinLoader/blob/15-develop/Common/src/main/java/customskinloader/config/Config.java
//     https://github.com/xfl03/MCCustomSkinLoader/blob/15-develop/Common/src/main/java/customskinloader/CustomSkinLoader.java
//     Modrinth 项目说明 https://modrinth.com/mod/customskinloader（Local Skin 段落列出上述三条默认路径）
//
// 这里只做「本启动器侧」的事：皮肤放两个目录（官方只读 / 用户可增删）、按账号记录选择、
// 落地时原子写 PNG 并「合并」而不是覆盖用户的 CustomSkinLoader.json。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { LocalSkin, LocalSkinSelection, SkinApplyResult } from "../../shared/types";
import { getAccount } from "../auth/accounts";
import { logger } from "../core/logger";
import { getPaths, instanceDir } from "../core/paths";
import { getSettings } from "../core/settings";
import { getInstance } from "../minecraft/instances";
import { installMod } from "../mods/index";
import { scanInstalledContent, type ScannedMod } from "../mods/installed";
import { decodePng, detectSkinModel, readPngSize } from "./png";

const log = logger("skins");

/** CustomSkinLoader 的 Modrinth 项目（slug 已核实：/v2/project/customskinloader 存在，project_type=mod）。 */
const CSL_PROJECT = "customskinloader";
const CSL_DIR = "CustomSkinLoader";
const CSL_CONFIG = "CustomSkinLoader.json";
/** 本地皮肤子目录（相对 <gameDir>/CustomSkinLoader）。 */
const CSL_LOCAL_SKINS = join("LocalSkin", "skins");

/** 只接受真实皮肤会出现的三种尺寸；其它尺寸视为无效文件（不列出、不导入）。 */
const VALID_SIZES = new Set(["64x64", "64x32", "128x128"]);
/** 导入上限 1MB：正常皮肤几十 KB，超过这个量级的多半不是皮肤。 */
const MAX_IMPORT_BYTES = 1024 * 1024;
/** 选择记录文件名（<dataRoot>/meta/local-skins.json）。 */
const SELECTIONS_FILE = "local-skins.json";

/** 磁盘上存的形状：accountId → { fileName, source, model }（accountId 是键，不重复存进记录里）。 */
type StoredSelection = Pick<LocalSkinSelection, "fileName" | "source" | "model">;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha1Of(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

/** 官方内置皮肤：<gameRoot>/skins，只读。 */
function officialDir(): string {
  return join(getPaths().gameRoot, "skins");
}

/** 用户导入皮肤：<dataRoot>/skins。 */
function userDir(): string {
  return join(getPaths().dataRoot, "skins");
}

function selectionsFile(): string {
  return join(getPaths().meta, SELECTIONS_FILE);
}

/**
 * 游戏目录口径与 launch.resolveGameDir 完全一致，但这里自己算：
 * launch 会 import 本模块挂启动钩子，反向 import 会形成循环依赖。
 */
function gameDirOf(instance: { id: string }): string {
  return getSettings().versionIsolation === "none" ? getPaths().gameRoot : instanceDir(instance.id);
}

async function ensureUserDir(): Promise<string> {
  const dir = userDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return Boolean(info && info.isFile());
}

/** 文件名清洗：只留单级文件名，非 .png 直接拒绝。 */
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

function safeSkinName(raw: string): string {
  const name = basename(String(raw ?? "").trim().replace(/\\/g, "/"));
  if (!name || name === "." || name === ".." || name.includes("\u0000")) {
    throw new Error("皮肤文件名无效：" + String(raw));
  }
  if (!/\.png$/i.test(name)) throw new Error("只能处理 .png 皮肤文件：" + name);
  return name;
}

/** 展示名/落盘名用的主干：清洗到 60 字符以内，空串回退 "skin"。 */
function cleanStem(filePath: string): string {
  const stem = basename(filePath, extname(filePath))
    .replace(BAD_NAME_CHARS, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 60);
  return stem.length > 0 ? stem : "skin";
}

/** 原子写：先写同目录临时文件再 rename，中途崩溃不会留下半张图。 */
async function writeFileAtomic(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = target + "." + process.pid + "." + Date.now().toString(36) + ".tmp";
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function tempPathOf(file: string): string {
  return file + "." + process.pid + "." + Date.now().toString(36) + ".tmp";
}

/** 尺寸是否被接受（64x64 / 64x32 / 128x128）。 */
function sizeKey(width: number, height: number): string {
  return width + "x" + height;
}

// ---------- 账号选择记录 ----------

/** 读取选择记录：文件缺失/损坏/字段不合法一律退化成空对象（皮肤库本身不依赖它）。 */
async function readSelections(): Promise<Record<string, StoredSelection>> {
  const text = await readFile(selectionsFile(), "utf8").catch(() => "");
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    log.warn("本地皮肤选择记录损坏，按空记录处理：" + selectionsFile());
    return {};
  }
  const out: Record<string, StoredSelection> = {};
  for (const [accountId, value] of Object.entries(asObject(raw))) {
    const entry = asObject(value);
    const fileName = typeof entry.fileName === "string" ? entry.fileName : "";
    if (!fileName) continue;
    out[accountId] = {
      fileName,
      source: entry.source === "official" ? "official" : "user",
      model: entry.model === "slim" ? "slim" : "classic",
    };
  }
  return out;
}

/** 写入串行化：并发 select 时两次「读-改-写」会互相覆盖（与 mods/rememberInstalled 同一套路）。 */
let selectionQueue: Promise<unknown> = Promise.resolve();

async function writeSelections(map: Record<string, StoredSelection>): Promise<void> {
  const run = selectionQueue.then(async () => {
    const file = selectionsFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = tempPathOf(file);
    await writeFile(tmp, JSON.stringify(map, null, 2) + "\n", "utf8");
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  });
  selectionQueue = run.catch(() => undefined);
  await run;
}

/** 某个文件名在哪个目录里（官方优先），并给出模型；不存在或尺寸非法时抛错。 */
async function locateSkin(
  fileName: string,
): Promise<{ source: "official" | "user"; path: string; model: "classic" | "slim" }> {
  const name = safeSkinName(fileName);
  for (const source of ["official", "user"] as const) {
    const path = join(source === "official" ? officialDir() : userDir(), name);
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile()) continue;
    const bytes = await readFile(path);
    const size = readPngSize(bytes);
    if (!size || !VALID_SIZES.has(sizeKey(size.width, size.height))) {
      throw new Error("皮肤尺寸无效（只支持 64x64 / 64x32 / 128x128）：" + name);
    }
    const image = decodePng(bytes);
    return { source, path, model: image ? detectSkinModel(image) : "classic" };
  }
  throw new Error("本地皮肤不存在：" + name);
}

// ---------- 对外：皮肤库 ----------

/**
 * 列出官方内置 + 用户导入的皮肤：按 source（官方在前）再按文件名排序。
 * 尺寸非法的 .png 直接跳过；accountId 用来标记哪个是当前选中的。
 */
export async function listLocalSkins(accountId?: string): Promise<LocalSkin[]> {
  await ensureUserDir();
  const selections = await readSelections();
  const selected = accountId ? selections[accountId] : undefined;
  const out: LocalSkin[] = [];
  for (const source of ["official", "user"] as const) {
    const dir = source === "official" ? officialDir() : userDir();
    const names = (await readdir(dir).catch(() => [] as string[])).sort();
    for (const fileName of names) {
      if (!/\.png$/i.test(fileName)) continue; // 非 png 与目录都不算皮肤
      const path = join(dir, fileName);
      const info = await stat(path).catch(() => undefined);
      if (!info || !info.isFile()) continue;
      const bytes = await readFile(path).catch(() => undefined);
      if (!bytes) continue;
      const size = readPngSize(bytes);
      if (!size || !VALID_SIZES.has(sizeKey(size.width, size.height))) continue;
      const image = decodePng(bytes);
      out.push({
        fileName,
        name: basename(fileName, extname(fileName)),
        source,
        path,
        sizeBytes: info.size,
        width: size.width,
        height: size.height,
        model: image ? detectSkinModel(image) : "classic",
        active: Boolean(selected && selected.fileName === fileName && selected.source === source),
      });
    }
  }
  return out;
}

/**
 * 导入皮肤：只收 .png、≤1MB、尺寸合法；内容（sha1）与已有文件相同直接跳过；
 * 同名但内容不同加 -2/-3 后缀；永远只写用户目录（官方目录只读）。
 */
export async function importLocalSkins(paths: string[]): Promise<{ imported: string[]; skipped: string[] }> {
  const dir = await ensureUserDir();
  const imported: string[] = [];
  const skipped: string[] = [];

  const taken = new Set<string>();
  const bySha = new Map<string, string>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/\.png$/i.test(name)) continue;
    taken.add(name);
    const bytes = await readFile(join(dir, name)).catch(() => undefined);
    if (bytes) bySha.set(sha1Of(bytes), name);
  }

  for (const raw of paths) {
    const source = typeof raw === "string" ? raw.trim() : "";
    const label = source ? basename(source) : "";
    if (!source || !/\.png$/i.test(source)) {
      skipped.push(label || source);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch {
      skipped.push(label);
      continue;
    }
    if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) {
      skipped.push(label);
      continue;
    }
    const size = readPngSize(bytes);
    if (!size || !VALID_SIZES.has(sizeKey(size.width, size.height))) {
      skipped.push(label);
      continue;
    }
    const sha1 = sha1Of(bytes);
    if (bySha.has(sha1)) {
      // 同一张图已经在库里：不重复占位
      skipped.push(label);
      continue;
    }

    const stem = cleanStem(source);
    let fileName = stem + ".png";
    for (let n = 2; taken.has(fileName) && n <= 99; n += 1) fileName = stem + "-" + n + ".png";
    try {
      // wx：并发导入同名文件时由文件系统保证只有一个成功
      await writeFile(join(dir, fileName), bytes, { flag: "wx" });
    } catch (err) {
      log.warn("导入皮肤失败：" + label + " · " + messageOf(err));
      skipped.push(label);
      continue;
    }
    taken.add(fileName);
    bySha.set(sha1, fileName);
    imported.push(fileName);
    log.info("已导入本地皮肤 " + fileName + "（" + sizeKey(size.width, size.height) + "，" + bytes.length + " 字节）");
  }
  return { imported, skipped };
}

/** 删除用户导入的皮肤；官方内置的直接报错。 */
export async function removeLocalSkin(fileName: string): Promise<LocalSkin[]> {
  const name = safeSkinName(fileName);
  if (await isFile(join(officialDir(), name))) throw new Error("官方内置皮肤不能删除：" + name);
  const target = join(userDir(), name);
  if (!(await isFile(target))) throw new Error("皮肤不存在：" + name);
  await unlink(target);

  // 选择记录指向已删文件会变成悬空指针：顺手清掉
  const selections = await readSelections();
  let changed = false;
  for (const [accountId, selection] of Object.entries(selections)) {
    if (selection.source === "user" && selection.fileName === name) {
      delete selections[accountId];
      changed = true;
    }
  }
  if (changed) await writeSelections(selections);
  log.info("已删除本地皮肤 " + name);
  return listLocalSkins();
}

/** 选中/取消选中某账号的本地皮肤（传 null 表示跟随账号原皮肤）。 */
export async function selectLocalSkin(accountId: string, fileName: string | null): Promise<LocalSkin[]> {
  const account = String(accountId ?? "").trim();
  if (!account) throw new Error("账号 id 不能为空");
  const selections = await readSelections();
  const name = fileName === null || fileName === undefined ? "" : safeSkinName(fileName);
  if (!name) {
    delete selections[account];
    await writeSelections(selections);
    return listLocalSkins(account);
  }
  const skin = await locateSkin(name);
  selections[account] = { fileName: name, source: skin.source, model: skin.model };
  await writeSelections(selections);
  log.info("账号 " + account + " 选用本地皮肤 " + name + "（" + skin.source + " / " + skin.model + "）");
  return listLocalSkins(account);
}

// ---------- 对外：写进实例（CustomSkinLoader） ----------

/** 实例里是否装了 CustomSkinLoader：先看 jar 元数据 modId，再退到文件名/显示名。 */
function isCustomSkinLoader(mod: ScannedMod): boolean {
  const modId = (mod.modId ?? "").toLowerCase();
  if (modId.startsWith("customskinloader")) return true;
  return /customskinloader/i.test(mod.fileName) || /custom\s*skin\s*loader/i.test(mod.name ?? "");
}

async function hasCustomSkinLoader(instanceId: string): Promise<boolean> {
  const mods = await scanInstalledContent(instanceId, "mod");
  return mods.some(isCustomSkinLoader);
}

/**
 * 把 LocalSkin 条目补进 loadlist / 校正模型。只合并、不覆盖：
 * 其它 loader、cape、用户自定义项与 config 上的其它字段原样保留。
 * 返回给界面看的提示（不需要提示时 undefined）。
 */
async function mergeLoadlist(configPath: string, model: "classic" | "slim"): Promise<string | undefined> {
  const text = await readFile(configPath, "utf8").catch(() => undefined);
  if (text === undefined) {
    // 不新建：CSL 首次启动会用默认 profile 生成配置（含 LocalSkin），我们抢先写一份会顶掉 Mojang 等默认来源
    return "实例还没有 CustomSkinLoader 配置，首次启动会由模组生成（含 LocalSkin）；细臂模型会在下一次应用时写入";
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "CustomSkinLoader.json 无法解析，已跳过配置合并（皮肤文件已就位）";
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "CustomSkinLoader.json 结构异常，已跳过配置合并（皮肤文件已就位）";
  }
  const config = raw as Record<string, unknown>;
  const list = Array.isArray(config.loadlist) ? config.loadlist : [];
  config.loadlist = list;
  const wanted = model === "slim" ? "slim" : "default";
  const existing = list.find((item) => String(asObject(item).name ?? "").toLowerCase() === "localskin");
  if (existing) {
    const entry = asObject(existing) as Record<string, unknown>;
    if (entry.model === wanted) return undefined;
    entry.model = wanted;
    await writeFileAtomic(configPath, Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8"));
    log.info("已把 " + configPath + " 里 LocalSkin 的 model 改为 " + wanted);
    return undefined;
  }
  // 缺 LocalSkin：插到最前面，本地皮肤优先于在线来源（与 CSL 默认配置里的顺序一致）
  list.unshift({ name: "LocalSkin", type: "Legacy", model: wanted });
  await writeFileAtomic(configPath, Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8"));
  log.info("已在 " + configPath + " 的 loadlist 补上 LocalSkin 条目");
  return undefined;
}

/**
 * 把某账号选中的本地皮肤写进实例：<gameDir>/CustomSkinLoader/LocalSkin/skins/<游戏名>.png，
 * 并确保 CustomSkinLoader.json 的 loadlist 有 LocalSkin 条目且 model 与皮肤一致。
 * 只有真正写了文件才会 applied=true；没装模组也照写（用户可能随后一键安装）。
 */
export async function applyToInstance(instanceId: string, accountId: string): Promise<SkinApplyResult> {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error("实例不存在：" + instanceId);
  const modInstalled = await hasCustomSkinLoader(instanceId);

  const selections = await readSelections();
  const selection = selections[accountId];
  if (!selection) return { applied: false, modInstalled, message: "该账号还没有选用本地皮肤" };

  let skin: { source: "official" | "user"; path: string; model: "classic" | "slim" };
  try {
    skin = await locateSkin(selection.fileName);
  } catch (err) {
    return { applied: false, modInstalled, message: messageOf(err) };
  }

  const account = await getAccount(accountId);
  const playerName = (account?.name ?? "").trim();
  if (!playerName) return { applied: false, modInstalled, message: "账号没有游戏名，无法确定皮肤文件名" };

  const bytes = await readFile(skin.path);
  const skinDir = join(gameDirOf(instance), CSL_DIR, CSL_LOCAL_SKINS);
  const skinFile = playerName + ".png";
  await writeFileAtomic(join(skinDir, skinFile), bytes);

  const notes: string[] = [];
  const configNote = await mergeLoadlist(join(gameDirOf(instance), CSL_DIR, CSL_CONFIG), skin.model).catch((err) => {
    log.warn("CustomSkinLoader 配置合并失败（皮肤文件已写入）：" + messageOf(err));
    return "配置合并失败：" + messageOf(err);
  });
  if (configNote) notes.push(configNote);
  if (!modInstalled) notes.push("实例里还没有 CustomSkinLoader，装上一键安装的模组后皮肤才会生效");

  log.info("已把本地皮肤 " + selection.fileName + " 写入 " + join(skinDir, skinFile) + "（modInstalled=" + modInstalled + "）");
  return {
    applied: true,
    modInstalled,
    skinFile,
    message: notes.length > 0 ? notes.join("；") : undefined,
  };
}

/** 一键安装 CustomSkinLoader（Modrinth slug customskinloader，挑适配实例版本+加载器的最优文件）。 */
export async function ensureMod(
  instanceId: string,
): Promise<{ installed: boolean; fileName?: string; message?: string }> {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error("实例不存在：" + instanceId);
  const existing = (await scanInstalledContent(instanceId, "mod")).find(isCustomSkinLoader);
  if (existing) return { installed: true, fileName: existing.fileName, message: "实例里已有 CustomSkinLoader" };
  try {
    const result = await installMod({ provider: "modrinth", projectId: CSL_PROJECT, instanceId, kind: "mod" });
    log.info("已安装 CustomSkinLoader：" + result.fileName + " → " + result.path);
    return { installed: true, fileName: result.fileName };
  } catch (err) {
    log.warn("安装 CustomSkinLoader 失败：" + messageOf(err));
    return { installed: false, message: "安装 CustomSkinLoader 失败：" + messageOf(err) };
  }
}
