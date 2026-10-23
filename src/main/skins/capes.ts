// 本地披风库：<dataRoot>/capes，与账号解耦，账号只记录「选了哪一张」。
// 披风只给离线账号用（通过本地皮肤 API 注入）；微软账号走官方数据，不读这里。
// 尺寸口径：披风贴图 64×32（现代）或 22×17（1.8 之前的老格式），其它一律视为无效文件。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { LocalCape } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { readPngSize } from "./png";

const log = logger("skins");

/** 只能收这两种披风尺寸（64x32 现代 / 22x17 老格式）。 */
const CAPE_SIZES = new Set(["64x32", "22x17"]);
/** 导入上限 1MB：正常披风几 KB。 */
const MAX_IMPORT_BYTES = 1024 * 1024;
const SELECTIONS_FILE = "local-capes.json";

/** 选择记录：accountId → fileName（披风没有模型字段）。 */
type StoredCapeSelection = { fileName: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha1Of(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

/** 用户披风目录：<dataRoot>/capes。 */
function capesDir(): string {
  return join(getPaths().dataRoot, "capes");
}

function selectionsFile(): string {
  return join(getPaths().meta, SELECTIONS_FILE);
}

async function ensureDir(): Promise<string> {
  const dir = capesDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

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
    if (fileName) out[accountId] = { fileName };
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

/** 某个披风文件名是否在库里，并给出绝对路径；不在或尺寸非法时抛错。 */
async function locateCape(fileName: string): Promise<{ path: string; fileName: string }> {
  const name = safeCapeName(fileName);
  const path = join(capesDir(), name);
  const info = await stat(path).catch(() => undefined);
  if (!info || !info.isFile()) throw new Error("披风不存在：" + name);
  const bytes = await readFile(path);
  const size = readPngSize(bytes);
  if (!size || !CAPE_SIZES.has(size.width + "x" + size.height)) {
    throw new Error("披风尺寸无效（只支持 64x32 / 22x17）：" + name);
  }
  return { path, fileName: name };
}

/** 列出本地披风（按文件名排序），accountId 用来标记当前选中。 */
export async function listCapes(accountId?: string): Promise<LocalCape[]> {
  const dir = await ensureDir();
  const selections = await readSelections();
  const selected = accountId ? selections[accountId] : undefined;
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const out: LocalCape[] = [];
  for (const fileName of names) {
    if (!/\.png$/i.test(fileName)) continue;
    const path = join(dir, fileName);
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile()) continue;
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes) continue;
    const size = readPngSize(bytes);
    if (!size || !CAPE_SIZES.has(size.width + "x" + size.height)) continue;
    out.push({
      fileName,
      name: basename(fileName, extname(fileName)),
      path,
      sizeBytes: info.size,
      width: size.width,
      height: size.height,
      active: Boolean(selected && selected.fileName === fileName),
    });
  }
  return out;
}

/** 导入披风：只收 .png / ≤1MB / 尺寸合法；sha1 重复跳过；同名不同内容加 -2/-3。 */
export async function importCapes(paths: string[]): Promise<{ imported: string[]; skipped: string[] }> {
  const dir = await ensureDir();
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
    if (!size || !CAPE_SIZES.has(size.width + "x" + size.height)) {
      skipped.push(label);
      continue;
    }
    const sha1 = sha1Of(bytes);
    if (bySha.has(sha1)) {
      skipped.push(label);
      continue;
    }
    const stem = cleanStem(source);
    let fileName = stem + ".png";
    for (let n = 2; taken.has(fileName) && n <= 99; n += 1) fileName = stem + "-" + n + ".png";
    try {
      await writeFile(join(dir, fileName), bytes, { flag: "wx" });
    } catch (err) {
      log.warn("导入披风失败：" + label + " · " + messageOf(err));
      skipped.push(label);
      continue;
    }
    taken.add(fileName);
    bySha.set(sha1, fileName);
    imported.push(fileName);
    log.info("已导入本地披风 " + fileName + "（" + size.width + "x" + size.height + "，" + bytes.length + " 字节）");
  }
  return { imported, skipped };
}

/** 删除本地披风，并清掉指向它的选择记录。 */
export async function removeCape(fileName: string): Promise<LocalCape[]> {
  const name = safeCapeName(fileName);
  const target = join(capesDir(), name);
  const info = await stat(target).catch(() => undefined);
  if (!info || !info.isFile()) throw new Error("披风不存在：" + name);
  await unlink(target);
  const selections = await readSelections();
  let changed = false;
  for (const [accountId, selection] of Object.entries(selections)) {
    if (selection.fileName === name) {
      delete selections[accountId];
      changed = true;
    }
  }
  if (changed) await writeSelections(selections);
  log.info("已删除本地披风 " + name);
  return listCapes();
}

/** 选中/取消某账号的本地披风（传 null 表示不使用本地披风）。 */
export async function selectCape(accountId: string, fileName: string | null): Promise<LocalCape[]> {
  const account = String(accountId ?? "").trim();
  if (!account) throw new Error("账号 id 不能为空");
  const selections = await readSelections();
  const name = fileName === null || fileName === undefined ? "" : safeCapeName(fileName);
  if (!name) {
    delete selections[account];
    await writeSelections(selections);
    return listCapes(account);
  }
  await locateCape(name);
  selections[account] = { fileName: name };
  await writeSelections(selections);
  log.info("账号 " + account + " 选用本地披风 " + name);
  return listCapes(account);
}

/** 本地皮肤 API 用：该账号当前选中的披风文件（不存在/已删则 undefined）。 */
export async function selectedLocalCape(accountId: string): Promise<{ path: string; fileName: string } | undefined> {
  const selections = await readSelections();
  const selection = selections[accountId];
  if (!selection) return undefined;
  try {
    return await locateCape(selection.fileName);
  } catch {
    return undefined;
  }
}
