// 卸载启动器自己装的 JDK：只允许删 <dataRoot>/java 下的目录。
// 系统安装的 JDK（Program Files、AppData 等）一律拒绝 —— 那是系统的资产，
// 启动器无权删除，用户应当用 JDK/发行方自带的卸载程序。
import { existsSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InstalledJava } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { mt } from "../core/i18n";
import { invalidateJavaCache, listInstalledJava } from "./locate";

const log = logger("java/uninstall");

/** Windows 上「文件/目录被占用」的 errno 集合（运行中的 java.exe 会锁住 bin\server\*.dll）。 */
const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "ENOTDIR"]);

/** 比较用的归一化路径：windows 大小写不敏感，反斜杠统一成斜杠。 */
function norm(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
}

/** 启动器管理的 JDK 根目录（<dataRoot>/java）。 */
export function managedJavaRoot(): string {
  return resolve(getPaths().java);
}

/**
 * 把入参解析成 JDK 根目录：
 * 传 javaw.exe（列表里的 path 就是它）→ 回到 <home>；传目录则原样使用。
 */
export async function resolveJavaHome(raw: string): Promise<string> {
  const abs = resolve(String(raw ?? "").trim());
  if (!String(raw ?? "").trim()) throw new Error(mt("java.uninstall.missingPath"));
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(mt("java.uninstall.notFound", { path: abs }));
  // <home>\bin\javaw.exe → <home>：往上退两级，绝不删到 bin
  return info.isFile() ? dirname(dirname(abs)) : abs;
}

/** 目标目录是否严格位于 <dataRoot>/java 之下（根目录自身也不算）。 */
export function isManagedJavaDir(home: string): boolean {
  const target = norm(home);
  const root = norm(managedJavaRoot());
  return target !== root && target.startsWith(root + "/");
}

/**
 * 占用预检：运行中的 java.exe 镜像、被映射的 jvm.dll 都只允许只读共享，
 * 所以「以写方式打开」会拿到 EBUSY —— 探测到就整体放弃，绝不把 JDK 删成半残。
 */
async function isJavaDirInUse(home: string): Promise<boolean> {
  // 只探测托管目录里我们自己可写的文件：系统 JDK 的 ACL 会让写打开失败，不能用来判断占用
  const probes = [join(home, "bin", "java.exe"), join(home, "bin", "server", "jvm.dll")];
  for (const file of probes) {
    if (!existsSync(file)) continue;
    try {
      const handle = await open(file, "r+");
      await handle.close();
    } catch {
      return true;
    }
  }
  return false;
}

/** 卸载一个托管 JDK，成功返回卸载后的已装列表。 */
export async function uninstallJava(raw: string): Promise<InstalledJava[]> {
  const home = await resolveJavaHome(raw);
  if (!isManagedJavaDir(home)) {
    log.warn("拒绝卸载非托管 JDK：" + home);
    throw new Error(mt("java.uninstall.system", { root: managedJavaRoot() }));
  }
  if (await isJavaDirInUse(home)) {
    log.warn("JDK 目录正被占用，放弃卸载：" + home);
    throw new Error(mt("java.uninstall.inUse"));
  }
  log.info("卸载 JDK：" + home);
  try {
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    log.warn("删除 JDK 目录失败（" + code + "）：" + (err instanceof Error ? err.message : String(err)));
    if (BUSY_CODES.has(code)) throw new Error(mt("java.uninstall.inUse"));
    throw new Error(mt("java.uninstall.failed", { error: err instanceof Error ? err.message : String(err) }));
  }
  invalidateJavaCache();
  return listInstalledJava(true);
}
