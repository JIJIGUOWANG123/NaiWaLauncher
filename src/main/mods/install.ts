import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { InstanceMeta, ModContentKind } from "../../shared/types";
import { createTask } from "../core/events";
import { downloadFile } from "../core/http";
import { logger } from "../core/logger";
import { getPaths, instanceDir } from "../core/paths";
import { getSettings } from "../core/settings";
import { modsDirForInstance, sha1OfFile } from "./installed";
import type { ResolvedFile } from "./provider";

const log = logger("mods");

/** 模组目录由实例隔离设置决定（none → <gameRoot>/mods）；对外仍从 install 导出。 */
export { modsDirForInstance } from "./installed";

const JAR_SUFFIX = ".jar";
/** Windows 文件名上限 120 字符（含后缀）：模组名再长也不能把路径撑爆。 */
const MAX_FILE_NAME = 120;

/** 非模组内容的落盘子目录（同样跟随实例隔离设置）。 */
const CONTENT_SUBDIRS: Record<"shader" | "resourcepack" | "modpack", string> = {
  shader: "shaderpacks",
  resourcepack: "resourcepacks",
  modpack: "modpacks",
};

/** 地图下载要登录麦块社区（mapFileUrl 全为 null），启动器暂不支持：整句文案直接抛给界面。 */
export const MAP_DOWNLOAD_HINT = "该地图需要登录麦块社区后下载（启动器暂不支持），已为你复制网页地址";

/**
 * 内容类型 → 落盘目录：mod → mods；shader → shaderpacks；resourcepack → resourcepacks；modpack → modpacks。
 * 版本隔离设为 none 时游戏的 --gameDir 就是 <gameRoot>，这些目录也必须放在 gameRoot 下才会被读到。
 */
export function contentDirForInstance(instance: { id: string }, kind: ModContentKind): string {
  if (kind === "mod") return modsDirForInstance(instance);
  if (kind === "map") throw new Error(MAP_DOWNLOAD_HINT);
  const sub = CONTENT_SUBDIRS[kind];
  return getSettings().versionIsolation === "none"
    ? join(getPaths().gameRoot, sub)
    : join(instanceDir(instance.id), sub);
}

/** 任务标题与日志里的名词。 */
const KIND_NOUN: Record<ModContentKind, string> = {
  mod: "模组",
  shader: "光影",
  resourcepack: "资源包",
  modpack: "整合包",
  map: "地图",
};

/** 文件名模板的占位符取值，缺字段按空串处理。 */
export interface ModNameVars {
  /** 项目显示名（Modrinth title / CurseForge name）。 */
  name?: string;
  slug?: string;
  version?: string;
  loader?: string;
  mc?: string;
}

/** 调用方已拿到的项目信息：给了就不再为空，省掉为模板补数据。 */
export type ModFileNameContext = Pick<ModNameVars, "name" | "slug" | "version">;

const PLACEHOLDERS = ["name", "slug", "version", "loader", "mc"] as const;

/** Windows 保留字符（含路径分隔符）与控制字符：换成连字符，删掉会把相邻单词粘连。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** 文件名模板渲染结果；fallback 为 true 表示模板不可用，已回退远端文件名。 */
export interface ModFileName {
  fileName: string;
  fallback: boolean;
  reason?: string;
}

/** 文件名来自远端，必须掐掉任何路径成分，避免写到 mods 目录之外。 */
export function safeFileName(raw: string): string {
  const name = basename(raw.trim().replace(/\\/g, "/"));
  if (!name || name === "." || name === ".." || name.includes("\u0000")) {
    throw new Error(`模组文件名无效：${raw}`);
  }
  return name;
}

/** 清理缺失字段留下的连续分隔符与空括号，并去掉首尾的空格/点/下划线。 */
function collapseSeparators(text: string): string {
  return text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\[\s*\]|\(\s*\)|\{\s*\}/g, "")
    .replace(/([ \-_.])[ \-_.]+/g, "$1")
    .replace(/^[ \-_.]+/, "")
    .replace(/[ \-_.]+$/, "");
}

/** 远端文件名给不出可用后缀时的兜底（整合包必须留 .mrpack，靠它才能被识别成整合包）。 */
const FALLBACK_SUFFIX: Record<ModContentKind, string> = {
  mod: JAR_SUFFIX,
  shader: ".zip",
  resourcepack: ".zip",
  modpack: ".mrpack",
  map: ".zip",
};

/** 落盘后缀：模组固定 .jar，其余沿用远端后缀（光影/资源包 .zip，整合包 .mrpack）。 */
export function contentSuffix(kind: ModContentKind, remoteFileName: string): string {
  if (kind === "mod") return JAR_SUFFIX;
  const ext = extname(remoteFileName).toLowerCase();
  return ext.length > 1 && ext.length <= 12 ? ext : FALLBACK_SUFFIX[kind];
}

/**
 * 模板渲染出的名字必须能被 Windows 接受：无路径成分、无保留字符、≤120 字符、以 suffix 结尾。
 * 清洗后什么都不剩时返回空串，由调用方决定回退。
 */
export function sanitizeContentFileName(raw: string, suffix: string): string {
  // 先掐路径成分（".." 段一并压掉），再谈长度与后缀
  let name = raw.replace(ILLEGAL_CHARS, "-").replace(/\.{2,}/g, ".");
  if (name.toLowerCase().endsWith(suffix)) name = name.slice(0, -suffix.length);
  name = collapseSeparators(name).replace(/^[ .]+/, "").replace(/[ .]+$/, "");
  if (!name) return "";
  const limit = MAX_FILE_NAME - suffix.length;
  if (name.length > limit) name = name.slice(0, limit).replace(/[ \-_.]+$/, "");
  return name ? `${name}${suffix}` : "";
}

/** 模组版（历史入口）：后缀固定 .jar。 */
export function sanitizeModFileName(raw: string): string {
  return sanitizeContentFileName(raw, JAR_SUFFIX);
}

/** 模板引用了、但这次拿不到值的占位符。 */
function missingFields(template: string, vars: ModNameVars): (typeof PLACEHOLDERS)[number][] {
  return PLACEHOLDERS.filter((key) => template.includes(`{${key}}`) && !(vars[key] ?? "").trim());
}

/**
 * 纯函数：模板 + 变量 → 落盘文件名。
 * 模板非法（空、无占位符）、字段拿不到值或渲染结果为空时回退远端文件名，绝不让不同模组
 * 塌缩成同一个文件（例如都变成 1.0.0.jar）。
 */
export function buildModFileName(
  template: string,
  vars: ModNameVars,
  remoteFileName: string,
  kind: ModContentKind = "mod",
): ModFileName {
  const remote = safeFileName(remoteFileName);
  const suffix = contentSuffix(kind, remote);
  const tpl = typeof template === "string" ? template.trim() : "";
  if (!tpl) return { fileName: remote, fallback: true, reason: "模板为空" };
  if (!PLACEHOLDERS.some((key) => tpl.includes(`{${key}}`))) {
    return { fileName: remote, fallback: true, reason: `模板「${tpl}」不含占位符` };
  }

  let text = tpl;
  for (const key of PLACEHOLDERS) text = text.split(`{${key}}`).join((vars[key] ?? "").trim());
  const fileName = sanitizeContentFileName(text, suffix);
  const missing = missingFields(tpl, vars);
  if (missing.length > 0) {
    return { fileName: remote, fallback: true, reason: `${missing.map((k) => `{${k}}`).join(" ")} 没有可用值` };
  }
  if (!fileName) return { fileName: remote, fallback: true, reason: `模板「${tpl}」生成的文件名为空` };
  // 双保险：清洗后仍出现路径成分说明规则有漏，宁可报错也不写穿 mods 目录
  if (basename(fileName) !== fileName) return { fileName: remote, fallback: true, reason: "模板生成了多级路径" };
  return { fileName, fallback: false };
}

/**
 * Modrinth 的 ModFileInfo.name 是「Sodium 0.6.13 for Fabric 1.21.4」这类长标题，
 * 取第一段版本号更贴近文件名里的 {version}；取不到就原样用（清洗阶段还会兜底）。
 */
function versionLabel(label: string): string {
  const matched = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.+-]+)?/.exec(label);
  return (matched ? matched[0] : label).trim();
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** {loader} {mc} 来自实例；{name} {slug} 用调用方的项目信息，其次用 getFile 顺手带回来的。 */
function modNameVars(
  instance: InstanceMeta,
  resolved: ResolvedFile,
  context?: ModFileNameContext,
): ModNameVars {
  return {
    name: context?.name ?? resolved.project?.title,
    slug: context?.slug ?? resolved.project?.slug,
    version: context?.version ?? versionLabel(resolved.info.name),
    loader: instance.loader,
    mc: instance.mcVersion,
  };
}

function resolveFileName(
  instance: InstanceMeta,
  resolved: ResolvedFile,
  context: ModFileNameContext | undefined,
  kind: ModContentKind,
): string {
  const remote = safeFileName(resolved.info.fileName);
  const result = buildModFileName(
    getSettings().modFileNameTemplate,
    modNameVars(instance, resolved, context),
    remote,
    kind,
  );
  if (result.fallback) {
    log.warn(`模组文件名模板不可用（${result.reason}），回退远端文件名 ${result.fileName}`);
  }
  return result.fileName;
}

/**
 * 下载到目标目录（mod → mods、shader → shaderpacks、resourcepack → resourcepacks、
 * modpack → modpacks，见 contentDirForInstance）下的 <fileName>，文件名按设置里的模板生成。
 * 目标已存在且 sha1 一致时直接复用（不重下也不留 .bak）；内容不同才备份成 .bak。
 */
export async function downloadModFile(
  instance: InstanceMeta,
  resolved: ResolvedFile,
  context?: ModFileNameContext,
  kind: ModContentKind = "mod",
  signal?: AbortSignal,
): Promise<{ fileName: string; path: string }> {
  // 地图没有公开直链：到这里只能说清楚去哪儿下，不能装出一个空文件
  if (kind === "map") throw new Error(MAP_DOWNLOAD_HINT);
  const noun = KIND_NOUN[kind];
  const fileName = resolveFileName(instance, resolved, context, kind);
  // 模板与远端名都过一遍检查：目标目录下只能是单级文件名
  if (!fileName || basename(fileName) !== fileName) throw new Error(`${noun}文件名无效：${fileName}`);
  const dir = contentDirForInstance(instance, kind);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, fileName);

  // 来源可能只给文件大小（CurseForge 无 Key 模式），据此兜住完整性
  const expectedSize = resolved.size && resolved.size > 0 ? resolved.size : undefined;
  const task = createTask("mod", `安装${noun} ${fileName}`);
  try {
    const existing = await stat(dest).catch(() => undefined);
    if (existing && existing.size > 0) {
      // 同一文件重复安装：有哈希按 sha1，没哈希按大小判定，命中就直接复用
      if (resolved.sha1 && (await sha1OfFile(dest)) === resolved.sha1.toLowerCase()) {
        log.info(`${noun} ${fileName} 已存在且 sha1 一致，直接复用`);
        task.done({ fileName, path: dest });
        return { fileName, path: dest };
      }
      if (!resolved.sha1 && expectedSize !== undefined && existing.size === expectedSize) {
        log.info(`${noun} ${fileName} 已存在且大小一致（${expectedSize} 字节），直接复用`);
        task.done({ fileName, path: dest });
        return { fileName, path: dest };
      }

      await copyFile(dest, `${dest}.bak`);
      log.warn(`${noun} ${fileName} 已存在且内容不同，已备份为 ${fileName}.bak`);
      // 没有哈希时 downloadFile 会把同名旧文件当成「已下好」直接复用，先清掉才能真下载
      if (!resolved.sha1) await unlink(dest).catch(() => undefined);
    }

    await downloadFile(resolved.info.downloadUrl, dest, {
      task,
      expectedSha1: resolved.sha1,
      connections: getSettings().connectionsPerFile,
      label: fileName,
      signal,
    });

    const size = (await stat(dest)).size;
    if (size <= 0) throw new Error(`下载的${noun}文件为空：${fileName}`);

    if (resolved.sha1) {
      const actual = await sha1OfFile(dest);
      if (actual.toLowerCase() !== resolved.sha1.toLowerCase()) {
        await unlink(dest).catch(() => undefined);
        throw new Error(`${noun} ${fileName} 校验失败：期望 sha1 ${resolved.sha1}，实际 ${actual}`);
      }
    } else if (expectedSize !== undefined && size !== expectedSize) {
      await unlink(dest).catch(() => undefined);
      throw new Error(
        `${noun} ${fileName} 大小校验失败：期望 ${expectedSize} 字节，实际 ${size} 字节（无哈希可校验，可能下载被截断或文件已变更）`,
      );
    } else {
      log.info(`${noun} ${fileName} 未做哈希校验（无 Key 模式或来源无哈希），已按大小 ${size} 字节确认`);
    }

    task.done({ fileName, path: dest });
    log.info(`已安装${noun} ${fileName} → ${dest}`);
    // 整合包只下不拆：解包/建实例属于另一套流程，先让用户拿到 .mrpack
    if (kind === "modpack") log.warn(`整合包 ${fileName} 已下载到 ${dir}，启动器暂不自动解包，请用导入功能或第三方工具处理`);
    return { fileName, path: dest };
  } catch (err) {
    task.fail(err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 删除实例 mods 目录里的 jar 与其 .bak；文件名先掐掉路径成分，防穿越。 */
export async function removeModFile(instanceId: string, fileName: string): Promise<void> {
  const name = safeFileName(fileName);
  if (!/\.jar$/i.test(name)) throw new Error(`只能删除 .jar 模组文件：${name}`);
  const target = join(modsDirForInstance({ id: instanceId }), name);
  if (!(await exists(target))) throw new Error(`模组文件不存在：${name}`);
  await unlink(target);
  await unlink(`${target}.bak`).catch(() => undefined);
  log.info(`已删除模组 ${name}`);
}

/** 目录随隔离设置（instances/<id>/mods 或 <gameRoot>/mods），不存在即视为没有模组。 */
export async function listInstalledMods(instanceId: string): Promise<{ fileName: string; sizeBytes: number }[]> {
  const dir = modsDirForInstance({ id: instanceId });
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const mods: { fileName: string; sizeBytes: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue; // .bak 备份不算已装模组
    const info = await stat(join(dir, entry.name)).catch(() => undefined);
    if (!info) continue;
    mods.push({ fileName: entry.name, sizeBytes: info.size });
  }
  mods.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return mods;
}
