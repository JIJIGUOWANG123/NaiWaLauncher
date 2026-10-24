// JDK 来源标记：安装时写一份记录，扫描时据此识别「这个 JDK 是谁装的」。
// 识别优先级（从强到弱）：
//   1) <home>/naiwa-source.json（本启动器安装时写的，最可靠）；
//   2) 目录名前缀 bellsoft- / adoptium- / tuna- / zulu- / oracle- / dragonwell-（我们自己定的命名规则）；
//   3) JDK 自带的 release 文件里的 IMPLEMENTOR（BellSoft / Adoptium / Azul / Oracle / Alibaba）；
//   4) 老版本启动器的 .naiwa.json 里 vendor 字符串（Liberica / Temurin / Zulu / Oracle / Dragonwell）；
//   都不满足就是 system（系统安装、Program Files 下的 JDK 等）。
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JavaVendorId } from "../../shared/types";

/** 来源记录文件名（放在 JDK 根目录里，与 .naiwa.json 并存）。 */
export const SOURCE_RECORD_FILE = "naiwa-source.json";

/** 启动器自己装的源（system 不是「装出来的」）。 */
export type ManagedSource = Exclude<JavaVendorId, "system">;

export interface JavaSourceRecord {
  source: ManagedSource;
  version: string;
  installedAt: number;
  downloadUrl: string;
}

const MANAGED: ManagedSource[] = ["bellsoft", "adoptium", "tuna", "zulu", "oracle", "dragonwell"];

export function isManagedSource(value: unknown): value is ManagedSource {
  return typeof value === "string" && (MANAGED as string[]).includes(value);
}

/** 目录名不能带 Windows 保留字符；来源 + 主版本 + 版本号拼成 <source>-<major>-<version>。 */
export function installDirName(source: ManagedSource, major: number, version: string): string {
  const safe = (text: string): string => text.replace(/[\\/:*?"<>|]/g, "_");
  return safe(source + "-" + major + "-" + version);
}

export async function readSourceRecord(home: string): Promise<JavaSourceRecord | undefined> {
  const file = join(home, SOURCE_RECORD_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (!isManagedSource(raw.source)) return undefined;
    return {
      source: raw.source,
      version: typeof raw.version === "string" ? raw.version : "",
      installedAt: typeof raw.installedAt === "number" ? raw.installedAt : 0,
      downloadUrl: typeof raw.downloadUrl === "string" ? raw.downloadUrl : "",
    };
  } catch {
    return undefined;
  }
}

export async function writeSourceRecord(home: string, record: JavaSourceRecord): Promise<void> {
  await writeFile(join(home, SOURCE_RECORD_FILE), JSON.stringify(record, null, 2), "utf8");
}

/** JDK release 文件（key=value，值可能带引号、行尾有 CR）。 */
async function readReleaseField(home: string, key: string): Promise<string> {
  const file = join(home, "release");
  if (!existsSync(file)) return "";
  const text = await readFile(file, "utf8").catch(() => "");
  const wanted = key.toUpperCase();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    if (line.slice(0, at).trim().toUpperCase() !== wanted) continue;
    return line.slice(at + 1).trim().replace(/^"|"$/g, "");
  }
  return "";
}

function vendorFromDirName(home: string): ManagedSource | undefined {
  const name = basename(home).toLowerCase();
  return MANAGED.find((vendor) => name.startsWith(vendor + "-"));
}

async function vendorFromReleaseFile(home: string): Promise<ManagedSource | undefined> {
  const text = [
    await readReleaseField(home, "IMPLEMENTOR"),
    await readReleaseField(home, "IMPLEMENTATION_VENDOR"),
  ]
    .join(" ")
    .toUpperCase();
  if (!text.trim()) return undefined;
  if (text.includes("BELLSOFT") || text.includes("LIBERICA")) return "bellsoft";
  if (text.includes("ADOPTIUM") || text.includes("TEMURIN")) return "adoptium";
  if (text.includes("AZUL")) return "zulu";
  // Dragonwell 的 IMPLEMENTOR 是 "Alibaba"，实现版本串里也会出现 Dragonwell，两个都认
  if (text.includes("ALIBABA") || text.includes("DRAGONWELL")) return "dragonwell";
  if (text.includes("ORACLE")) return "oracle";
  return undefined;
}

/** 识别已装 JDK 的来源；识别不出按系统安装处理。 */
export async function detectVendor(home: string, metaVendor?: string): Promise<JavaVendorId> {
  const record = await readSourceRecord(home);
  if (record) return record.source;
  const byName = vendorFromDirName(home);
  if (byName) return byName;
  const byRelease = await vendorFromReleaseFile(home);
  if (byRelease) return byRelease;
  // 老版本启动器只写 .naiwa.json（vendor = "BellSoft Liberica"），没有来源记录
  const legacy = String(metaVendor ?? "").toUpperCase();
  if (legacy.includes("BELLSOFT") || legacy.includes("LIBERICA")) return "bellsoft";
  if (legacy.includes("ADOPTIUM") || legacy.includes("TEMURIN")) return "adoptium";
  if (legacy.includes("AZUL")) return "zulu";
  if (legacy.includes("ALIBABA") || legacy.includes("DRAGONWELL")) return "dragonwell";
  if (legacy.includes("ORACLE")) return "oracle";
  return "system";
}
