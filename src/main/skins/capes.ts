// 披风库：内置披风（随程序分发、只读）+ 用户披风（<dataRoot>/capes，可增删）。
// 与内置皮肤完全对称；披风只给离线账号用（通过本地皮肤 API 注入），微软/第三方账号走各自官方数据。
// 尺寸口径：披风贴图 64×32（现代）或 22×17（1.8 之前的老格式），其它一律视为无效文件。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { LocalCape } from "../../shared/types";
import { getAccount } from "../auth/accounts";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { decodePng, encodePng, readPngSize, scaleNearest } from "./png";

const log = logger("skins");

/** 落盘只允许这两种尺寸（64x32 现代 / 22x17 老格式）。 */
const CAPE_SIZES = new Set(["64x32", "22x17"]);
/** 尺寸不合规时的统一文案（导入失败原因要给用户看得懂）。 */
const CAPE_SIZE_HINT = "披风尺寸需为 64×32、22×17，或 64×32 的整数倍放大图（如 1024×512）";

/** 归一化后的披风：放大图会缩成 64×32，字节也是新的 PNG。 */
interface PreparedCape {
  bytes: Buffer;
  width: number;
  height: number;
  /** 是否做过缩放（日志与自检用）。 */
  scaled: boolean;
}

/**
 * 校验并归一化披风图片：
 * · 64×32 / 22×17 原样保留；
 * · 64×32 的整数倍放大图（w=64k、h=32k，k≥2）用最近邻缩回 64×32 并重新编码成 PNG；
 * · 其它尺寸抛错（文案见 CAPE_SIZE_HINT），不是 PNG 的也抛错。
 */
export function prepareCape(bytes: Buffer): PreparedCape {
  const size = readPngSize(bytes);
  if (!size) throw new Error("不是有效的 PNG（文件头不是 PNG）");
  const width = size.width;
  const height = size.height;
  if (CAPE_SIZES.has(width + "x" + height)) return { bytes, width, height, scaled: false };
  const factor = width % 64 === 0 && height % 32 === 0 ? width / 64 : 0;
  if (factor >= 2 && height / 32 === factor) {
    const image = decodePng(bytes);
    if (!image) throw new Error("不是有效的 PNG（像素无法解码）");
    const scaled = scaleNearest(image.data, width, height, 64, 32);
    return { bytes: encodePng(scaled, 64, 32), width: 64, height: 32, scaled: true };
  }
  throw new Error(CAPE_SIZE_HINT);
}
/** 导入上限 1MB：正常披风几 KB。 */
const MAX_IMPORT_BYTES = 1024 * 1024;
const SELECTIONS_FILE = "local-capes.json";

type CapeSource = "official" | "user";

/** 选择记录：accountId → { fileName, source }（source 缺省按 user，兼容旧记录）。 */
type StoredCapeSelection = { fileName: string; source: CapeSource };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha1Of(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

/**
 * 内置披风目录：与内置皮肤同一套解析 —— 打包后是 <安装目录>/resources/capes
 * （electron-builder 的 extraResources 会随程序分发），开发态是 <仓库>/resources/capes。
 * 只读：任何入口都不写、不删这里。
 */
function officialDir(): string {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return res ? join(res, "capes") : join(getPaths().root, "resources", "capes");
}

/** 用户披风目录：<dataRoot>/capes。 */
function userDir(): string {
  return join(getPaths().dataRoot, "capes");
}

function dirOf(source: CapeSource): string {
  return source === "official" ? officialDir() : userDir();
}

function selectionsFile(): string {
  return join(getPaths().meta, SELECTIONS_FILE);
}

async function ensureUserDir(): Promise<string> {
  const dir = userDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** 只接受单级文件名：内置披风里有空格与中文，这里只掐路径成分，不改动其它字符。 */
function safeCapeName(raw: string): string {
  const name = basename(String(raw ?? "").trim().replace(/\\/g, "/"));
  if (!name || name === "." || name === ".." || name.includes("\u0000")) throw new Error("披风文件名无效：" + String(raw));
  if (!/\.png$/i.test(name)) throw new Error("只能处理 .png 披风文件：" + name);
  return name;
}

function cleanStem(filePath: string): string {
  const stem = basename(filePath, extname(filePath))
    .replace(BAD_NAME_CHARS, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 60);
  return stem.length > 0 ? stem : "cape";
}

/** 原子写：同目录临时文件 + rename。 */
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

async function readSelections(): Promise<Record<string, StoredCapeSelection>> {
  const text = await readFile(selectionsFile(), "utf8").catch(() => "");
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    log.warn("披风选择记录损坏，按空记录处理：" + selectionsFile());
    return {};
  }
  const out: Record<string, StoredCapeSelection> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [accountId, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const fileName = typeof entry.fileName === "string" ? entry.fileName : "";
    if (!fileName) continue;
    // 旧记录没有 source：那时只有用户目录，一律按 user 处理
    out[accountId] = { fileName, source: entry.source === "official" ? "official" : "user" };
  }
  return out;
}

let writeQueue: Promise<unknown> = Promise.resolve();

/** 写入串行化：并发 select 的「读-改-写」会互相覆盖。 */
async function writeSelections(map: Record<string, StoredCapeSelection>): Promise<void> {
  const run = writeQueue.then(async () => {
    const file = selectionsFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + "." + Date.now().toString(36) + ".tmp";
    await writeFile(tmp, JSON.stringify(map, null, 2) + "\n", "utf8");
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  });
  writeQueue = run.catch(() => undefined);
  await run;
}

/** 读一个披风并校验（存在 / 是文件 / 尺寸合法），不合法返回 undefined。 */
async function readCapeFile(
  source: CapeSource,
  fileName: string,
): Promise<{ path: string; fileName: string; source: CapeSource; sizeBytes: number; width: number; height: number } | undefined> {
  const path = join(dirOf(source), fileName);
  const info = await stat(path).catch(() => undefined);
  if (!info || !info.isFile()) return undefined;
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return undefined;
  const size = readPngSize(bytes);
  if (!size || !CAPE_SIZES.has(size.width + "x" + size.height)) return undefined;
  return { path, fileName, source, sizeBytes: info.size, width: size.width, height: size.height };
}

/** 定位披风：给了 source 就只查那个目录，否则内置优先（内置与用户同名时以内置为准）。 */
async function locateCape(
  fileName: string,
  source?: CapeSource,
): Promise<{ path: string; fileName: string; source: CapeSource; sizeBytes: number; width: number; height: number }> {
  const name = safeCapeName(fileName);
  const order: CapeSource[] = source ? [source] : ["official", "user"];
  for (const candidate of order) {
    const found = await readCapeFile(candidate, name);
    if (found) return found;
  }
  throw new Error(source === "official" ? "内置披风不存在：" + name : "披风不存在：" + name);
}

/** 列出一个目录里的披风（按文件名排序）。 */
async function listDir(source: CapeSource, selected: StoredCapeSelection | undefined): Promise<LocalCape[]> {
  const dir = dirOf(source);
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const out: LocalCape[] = [];
  for (const fileName of names) {
    if (!/\.png$/i.test(fileName)) continue;
    const found = await readCapeFile(source, fileName);
    if (!found) continue;
    out.push({
      fileName,
      name: basename(fileName, extname(fileName)),
      source,
      path: found.path,
      sizeBytes: found.sizeBytes,
      width: found.width,
      height: found.height,
      active: Boolean(selected && selected.fileName === fileName && selected.source === source),
    });
  }
  return out;
}

/** 列出披风：内置在前、用户在后，各自按文件名排序；accountId 用来标记当前选中。 */
export async function listCapes(accountId?: string): Promise<LocalCape[]> {
  await ensureUserDir();
  const selections = await readSelections();
  const selected = accountId ? selections[accountId] : undefined;
  const official = await listDir("official", selected);
  const user = await listDir("user", selected);
  return [...official, ...user];
}

/** 导入披风：只收 .png / ≤1MB / 尺寸合法；sha1 重复跳过；同名不同内容加 -2/-3；永远只写用户目录。 */
export async function importCapes(paths: string[]): Promise<{ imported: string[]; skipped: string[] }> {
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
      log.warn("跳过披风 " + (label || source) + "：只支持 .png 文件");
      skipped.push(label || source);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch (err) {
      log.warn("跳过披风 " + label + "：无法读取 · " + messageOf(err));
      skipped.push(label);
      continue;
    }
    if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) {
      log.warn("跳过披风 " + label + "：文件为 " + bytes.length + " 字节，超过 1MB 上限");
      skipped.push(label);
      continue;
    }
    let prepared: PreparedCape;
    try {
      prepared = prepareCape(bytes);
    } catch (err) {
      log.warn("跳过披风 " + label + "：" + messageOf(err));
      skipped.push(label);
      continue;
    }
    // 去重按「归一化后的字节」算：同一张披风的 1024×512 与 64×32 版本算同一张
    const sha1 = sha1Of(prepared.bytes);
    if (bySha.has(sha1)) {
      skipped.push(label);
      continue;
    }
    const stem = cleanStem(source);
    let fileName = stem + ".png";
    for (let n = 2; taken.has(fileName) && n <= 99; n += 1) fileName = stem + "-" + n + ".png";
    try {
      await writeFile(join(dir, fileName), prepared.bytes, { flag: "wx" });
    } catch (err) {
      log.warn("导入披风失败：" + label + " · " + messageOf(err));
      skipped.push(label);
      continue;
    }
    taken.add(fileName);
    bySha.set(sha1, fileName);
    imported.push(fileName);
    log.info(
      "已导入本地披风 " +
        fileName +
        "（" +
        prepared.width +
        "x" +
        prepared.height +
        (prepared.scaled ? "，已从放大图缩放到 64×32" : "") +
        "，" +
        prepared.bytes.length +
        " 字节）",
    );
  }
  return { imported, skipped };
}

/** 删除用户披风；内置披风直接报错（只读）。 */
export async function removeCape(fileName: string): Promise<LocalCape[]> {
  const name = safeCapeName(fileName);
  if (await readCapeFile("official", name)) throw new Error("内置披风不能删除：" + name);
  const target = join(userDir(), name);
  const info = await stat(target).catch(() => undefined);
  if (!info || !info.isFile()) throw new Error("披风不存在：" + name);
  await unlink(target);
  const selections = await readSelections();
  let changed = false;
  for (const [accountId, selection] of Object.entries(selections)) {
    if (selection.source === "user" && selection.fileName === name) {
      delete selections[accountId];
      changed = true;
    }
  }
  if (changed) await writeSelections(selections);
  log.info("已删除本地披风 " + name);
  return listCapes();
}

/**
 * 选中/取消某账号的披风。只有离线账号可以选本地/内置披风：
 * 第三方与正版账号的皮肤披风必须来自各自官方数据，主进程这层直接拒绝（不只靠界面禁）。
 */
export async function selectCape(accountId: string, fileName: string | null): Promise<LocalCape[]> {
  const account = String(accountId ?? "").trim();
  if (!account) throw new Error("账号 id 不能为空");
  const record = await getAccount(account);
  if (!record) throw new Error("账号不存在：" + account);
  if (record.type !== "offline") throw new Error("第三方与正版账号不能使用本地/内置披风");

  const selections = await readSelections();
  const name = fileName === null || fileName === undefined ? "" : safeCapeName(fileName);
  if (!name) {
    delete selections[account];
    await writeSelections(selections);
    return listCapes(account);
  }
  const cape = await locateCape(name);
  selections[account] = { fileName: cape.fileName, source: cape.source };
  await writeSelections(selections);
  log.info("账号 " + account + " 选用" + (cape.source === "official" ? "内置" : "本地") + "披风 " + cape.fileName);
  return listCapes(account);
}

/** 本地皮肤 API 用：该账号当前选中的披风（按记录的 source 解析；找不到就当没有披风）。 */
export async function selectedLocalCape(
  accountId: string,
): Promise<{ path: string; fileName: string; source: CapeSource } | undefined> {
  const selections = await readSelections();
  const selection = selections[accountId];
  if (!selection) return undefined;
  const found = await readCapeFile(selection.source, safeCapeNameSafe(selection.fileName));
  return found ? { path: found.path, fileName: found.fileName, source: found.source } : undefined;
}

/** safeCapeName 的「不抛错」版本：记录被手改坏时只当没有披风。 */
function safeCapeNameSafe(raw: string): string {
  try {
    return safeCapeName(raw);
  } catch {
    return "";
  }
}
