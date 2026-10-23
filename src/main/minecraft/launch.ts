import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Account, InstanceMeta, ProcessPriority, WindowMode } from "../../shared/types";
import { getActiveAccount } from "../auth/accounts";
import { ensureFreshToken, resolveMinecraftSession } from "../auth/microsoft";
import {
  authlibInjectorArg,
  authlibInjectorSupported,
  ensureAuthlibInjector,
  resolveYggdrasilSession,
} from "../auth/yggdrasil";
import { logger } from "../core/logger";
import { getPaths, instanceDir, versionDir } from "../core/paths";
import { getSettings } from "../core/settings";
import { resolveJavaFor } from "../java/index";
import { LAUNCH_FEATURES, mavenPathOf, missingPlaceholders, nativesClassifierAllowed, rulesAllow, splitArgs, substitute } from "./args";
import { selectedLocalCape } from "../skins/capes";
import { applyToInstance, selectedLocalSkin } from "../skins/local";
import { registerOfflineProfile, startSkinApi } from "../skins/localapi";
import { getInstance, updateInstance } from "./instances";
import { getVersionJson, resolveBaseVersionId } from "./manifest";

const log = logger("launch");

/**
 * 本进程启动的游戏子进程（instanceId → 子进程）。
 * 只用于「同时运行实例」的限制：启动器重启后这张表会清空，无法跨进程追踪 ——
 * 也就是说重启启动器后，之前启动的游戏不会被算在并发里（不去扫系统进程，避免误伤）。
 */
const runningGames = new Map<string, { child: ChildProcess; name: string }>();

/**
 * 启动前的并发检查：
 * · 同一实例重复启动 → 「该实例已经在运行」；
 * · 设置 gameInstanceLimit = "one"（默认）且已有存活实例 → 报错并提示怎么放开；
 * · "unlimited" 只拦同实例重复启动。
 */
function assertGameSlot(instanceId: string, instanceName: string, limit: "one" | "unlimited"): void {
  const same = runningGames.get(instanceId);
  if (same) throw new Error("该实例已经在运行：" + same.name + "（pid " + String(same.child.pid ?? 0) + "）");
  if (limit !== "one") return;
  const other = runningGames.values().next();
  if (other.done || !other.value) return;
  throw new Error(
    "已经有一个游戏在运行（实例：" + other.value.name + "）。可在设置里把「同时运行实例」改成「无限」后再开第二个。",
  );
}

/** 本地错误文案（launch 里已经有同语义的写法，单独抽一个避免重复三元表达式）。 */
function messageOfLaunch(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const LAUNCHER_VERSION = "0.1.5";
// 离线模式：服务端只校验令牌前缀，给个占位值即可
const OFFLINE_TOKEN = "0";
const USER_TYPE = "legacy";
// 原版客户端不给 --width/--height 时的默认窗口大小（854x480）；windowSize="default" 就用它
const DEFAULT_WINDOW_WIDTH = 854;
const DEFAULT_WINDOW_HEIGHT = 480;
const MIN_WINDOW_SIDE = 320;
const MAX_WINDOW_SIDE = 7680;
const DEFAULT_BRAND = "NaiWa";
/** 1.20 起才有 --quickPlaySingleplayer：更低版本直接报错，不静默忽略。 */
const QUICK_PLAY_MIN_MAJOR = 1;
const QUICK_PLAY_MIN_MINOR = 20;
/** 约定值：不指定存档，让游戏自己新建世界并直接进入（真实文件夹名由游戏决定）。 */
const QUICK_PLAY_NEW = "__new__";

/** quickPlay 传给游戏的一定不存在的 level id 前缀：游戏据此建新世界。 */
const NEW_LEVEL_PREFIX = "__naiwa_new_";

/** 与 Mojang 的 UUID v3 一致（"OfflinePlayer:<name>" 的 MD5，置版本位），离线服认这个值。 */
function offlineUuid(name: string): string {
  const digest = createHash("md5").update("OfflinePlayer:" + name, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** 离线用户名只允许字母数字下划线且不超过 16 字符，否则服务端拒绝登录。 */
function playerNameOf(instance: InstanceMeta): string {
  const cleaned = instance.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "Player";
}

/** 账号里存的 UUID 是无横线 32 位；原版客户端按带横线的形式校验，这里统一格式化。 */
function formatUuid(raw: string): string {
  const hex = String(raw ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 32) return String(raw ?? "");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

interface LaunchIdentity {
  name: string;
  uuid: string;
  accessToken: string;
  userType: "legacy" | "msa" | "mojang";
  xuid: string;
  /** 账号名（进 ${profile_name}）；兜底时用实例名。 */
  profileName: string;
  source: "account" | "name-fallback";
  /** 第三方账号的 API 根地址；有值时必须注入 authlib-injector。 */
  yggdrasilApiUrl?: string;
  /** 离线账号的 id（选了本地皮肤/披风时要用它起本地皮肤 API）。 */
  offlineAccountId?: string;
}

/**
 * 身份来源：优先当前账号（离线账号直接用，微软账号先刷新令牌），没有账号才回退到实例名。
 * 微软账号刷新失败必须报错中断：静默降级会让玩家以离线身份进服。
 */
async function resolveIdentity(instance: InstanceMeta): Promise<LaunchIdentity> {
  let account: Account | undefined;
  try {
    account = await getActiveAccount();
  } catch (err) {
    log.warn("读取当前账号失败，回退到实例名：" + (err instanceof Error ? err.message : String(err)));
  }

  if (!account) {
    const name = playerNameOf(instance);
    log.warn("未选择账号，已回退为离线用户名「" + name + "」（实例名清洗结果）");
    return {
      name,
      uuid: offlineUuid(name),
      accessToken: OFFLINE_TOKEN,
      userType: USER_TYPE,
      xuid: "",
      profileName: instance.name,
      source: "name-fallback",
    };
  }

  if (account.type === "microsoft") {
    // 先确保微软令牌新鲜，再换成 Minecraft services token：游戏要的是后者，不是微软 access token
    const fresh = await ensureFreshToken(account);
    const session = await resolveMinecraftSession(fresh);
    if (!session.accessToken) throw new Error("微软账号的 Minecraft 令牌为空，请重新登录账号");
    return {
      name: session.name || fresh.name,
      uuid: formatUuid(session.uuid || fresh.uuid),
      accessToken: session.accessToken,
      userType: "msa",
      xuid: fresh.microsoft?.xuid ?? "",
      profileName: session.name || fresh.name,
      source: "account",
    };
  }

  if (account.type === "yggdrasil" && account.yggdrasil) {
    // 第三方账号：令牌失效会先续期一次；续不上也继续启动（离线服仍可进），由 resolveYggdrasilSession 打 warn
    const session = await resolveYggdrasilSession(account);
    // userType 用 mojang：这条路直接用现成 accessToken 交给 authlib-injector 校验/进服，
    // 而 legacy 会让客户端拿令牌当密码重新 authenticate，第三方服务端不接受
    return {
      name: session.name || account.name,
      uuid: formatUuid(session.uuid || account.uuid) || offlineUuid(account.name),
      accessToken: session.accessToken,
      userType: "mojang",
      xuid: "",
      profileName: session.name || account.name,
      source: "account",
      yggdrasilApiUrl: account.yggdrasil.apiUrl,
    };
  }

  // 离线账号：token 只用于通过本地校验，离线服务端不验证
  return {
    name: account.name,
    uuid: formatUuid(account.uuid) || offlineUuid(account.name),
    accessToken: OFFLINE_TOKEN,
    userType: "legacy",
    xuid: "",
    profileName: account.name,
    source: "account",
    offlineAccountId: account.id,
  };
}

/**
 * 纯函数：本地皮肤 API 的注入参数（自检直接断言，避免为了它去跑完整启动流程）。
 * -javaagent 必须在主类之前进入 JVM，调用方把它放到 jvm 参数最前面。
 */
export function offlineSkinArgs(jarPath: string, apiBaseUrl: string): string[] {
  return [authlibInjectorArg(jarPath, apiBaseUrl), "-Dauthlibinjector.side=client"];
}

/**
 * 离线账号 + 选了本地皮肤/披风：起本地皮肤 API 并返回注入参数。
 * 任何一步失败都只 warn 并返回空数组 —— 降级到「装 CustomSkinLoader」的老路，绝不阻断启动。
 */
async function offlineLocalSkinInjection(instance: InstanceMeta, identity: LaunchIdentity): Promise<string[]> {
  const accountId = identity.offlineAccountId;
  if (!accountId) return [];
  // 注入 javaagent 是杀毒软件重点盯的行为：默认关闭，只有用户显式打开才走这条路
  if (!getSettings().localSkinApi) return [];
  try {
    const [skin, cape] = await Promise.all([selectedLocalSkin(accountId), selectedLocalCape(accountId)]);
    // 什么都没选：保持原样启动，不注入、不起服务
    if (!skin && !cape) return [];

    const supported = authlibInjectorSupported(instance.mcVersion);
    if (supported === false) {
      log.warn(
        "该版本（" + instance.mcVersion + "）低于 1.7.10，authlib-injector 无法注入：本地皮肤/披风不会生效；" +
          "可以改用「一键安装 CustomSkinLoader」的方式",
      );
      return [];
    }

    const api = await startSkinApi();
    if (!api) {
      log.warn("本地皮肤 API 启动失败，已回退到「装 CustomSkinLoader」的方式（皮肤/披风本次不生效）");
      return [];
    }
    registerOfflineProfile({ accountId, uuid: identity.uuid, name: identity.name });

    let jar: string;
    try {
      jar = (await ensureAuthlibInjector()).path;
    } catch (err) {
      log.warn(
        "下载 authlib-injector 失败，已回退到「装 CustomSkinLoader」的方式（皮肤/披风本次不生效）：" + messageOfLaunch(err),
      );
      return [];
    }
    log.info("已注入本地皮肤 API：" + jar + " → " + api.baseUrl);
    return offlineSkinArgs(jar, api.baseUrl);
  } catch (err) {
    log.warn("本地皮肤注入失败（不影响启动，可改用 CustomSkinLoader）：" + messageOfLaunch(err));
    return [];
  }
}

/** 版本隔离：
 * all  = 每个实例独立的游戏目录（<root>/.minecraft/instances/<id>）
 * none = 所有实例共用 <root>/.minecraft（options.txt、saves、mods 都落在那边）
 */
export function resolveGameDir(instance: InstanceMeta): string {
  const isolation = getSettings().versionIsolation;
  return isolation === "none" ? getPaths().gameRoot : instanceDir(instance.id);
}

/** mods 目录必须跟着游戏目录走，否则共用目录模式下装进实例目录的模组游戏读不到。 */
export function resolveModsDir(instance: InstanceMeta): string {
  const isolation = getSettings().versionIsolation;
  return isolation === "none" ? join(getPaths().gameRoot, "mods") : join(instanceDir(instance.id), "mods");
}

/** 实例窗口设置：实例自己选过就用实例的，没选过沿用「启动」页的全局默认。 */
export interface WindowSpec {
  fullscreen: boolean;
  width: number;
  height: number;
  /** 实例是否显式选过窗口形态：没选过就不去动 options.txt 里的 fullscreen。 */
  explicit: boolean;
}

/** windowSize 形如 "1280x720"；"default"、空串或非法值一律回落到原版默认 854x480。 */
export function parseWindowSize(raw: string | undefined): { width: number; height: number } {
  const match = /^\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*$/.exec(raw ?? "");
  const clamp = (value: number): number => Math.min(MAX_WINDOW_SIDE, Math.max(MIN_WINDOW_SIDE, value));
  const fallback = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback;
  return { width: clamp(width), height: clamp(height) };
}

/** 解析实例窗口设置；"inherit"/缺省回落到全局 windowSize。 */
export function resolveWindowSpec(instance: InstanceMeta): WindowSpec {
  const mode: WindowMode = instance.windowMode ?? "inherit";
  const own = (instance.windowSize ?? "").trim();
  const size = own === "" || own === "inherit" ? getSettings().windowSize : own;
  const parsed = parseWindowSize(size);
  return { fullscreen: mode === "fullscreen", width: parsed.width, height: parsed.height, explicit: mode !== "inherit" };
}

/** 游戏窗口标题：空设置沿用实例名，非空时展开 {instance} {version}。 */
export function resolveWindowTitle(instance: InstanceMeta): string {
  const template = (getSettings().windowTitle ?? "").trim();
  if (template.length === 0) return instance.name;
  return template
    .replace(/\{instance\}/g, instance.name)
    .replace(/\{version\}/g, instance.mcVersion);
}

/** 启动器标识：空串回落到 NaiWa，写进 -Dminecraft.launcher.brand。 */
function launcherBrand(): string {
  const brand = (getSettings().launcherBrand ?? "").trim();
  return brand.length > 0 ? brand : DEFAULT_BRAND;
}

/**
 * 内存参数。Xms/Xmx 永远下发；设置里开启「游戏内存优化」时再追加一套面向低延迟的
 * G1GC 组合（Aikar 风格），显著减少整合包里的 GC 卡顿；关掉就只留堆大小，交给 JVM 默认 GC。
 */
function jvmTuningArgs(memoryMb: number, optimize: boolean): string[] {
  const xmx = Math.max(512, Math.round(memoryMb));
  const xms = Math.min(xmx, 2048);
  const heap = ["-Xms" + xms + "M", "-Xmx" + xmx + "M"];
  if (!optimize) return heap;
  return [
    ...heap,
    "-XX:+UseG1GC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    "-XX:G1NewSizePercent=30",
    "-XX:G1MaxNewSizePercent=40",
    "-XX:G1HeapRegionSize=8M",
    "-XX:G1ReservePercent=20",
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    "-XX:InitiatingHeapOccupancyPercent=15",
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:+PerfDisableSharedMem",
    "-XX:MaxTenuringThreshold=1",
    "-Dfile.encoding=UTF-8",
    "-Dstdout.encoding=UTF-8",
    "-Dstderr.encoding=UTF-8",
  ];
}

/** 展开 arguments 数组里的字符串项与带 rules 的对象项。 */
function argumentValues(entries: any, features: Record<string, boolean>): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (!rulesAllow(entry.rules, features)) continue;
    if (typeof entry.value === "string") out.push(entry.value);
    else if (Array.isArray(entry.value)) out.push(...entry.value.map(String));
  }
  return out;
}

/** 合并后 libraries 里的全部 classpath 条目（跳过纯 natives 库）。 */
function classpathEntries(json: any): string[] {
  const paths = getPaths();
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const lib of Array.isArray(json.libraries) ? json.libraries : []) {
    if (!rulesAllow(lib?.rules)) continue;
    if (!nativesClassifierAllowed(String(lib?.name ?? ""))) continue;
    const artifactPath = lib.downloads?.artifact?.path;
    const rel = artifactPath ? String(artifactPath) : lib.name ? mavenPathOf(String(lib.name)) : "";
    if (rel.length === 0 || seen.has(rel)) continue;
    seen.add(rel);
    entries.push(join(paths.libraries, rel));
  }
  return entries;
}

/** 加载器版本自己没有 natives 目录，退回原版目录（natives 都在原版安装时解压）。 */
async function resolveNativesDir(versionId: string, baseVersionId: string): Promise<string> {
  const own = join(versionDir(versionId), "natives");
  if (existsSync(own)) return own;
  const base = join(versionDir(baseVersionId), "natives");
  // 1.19 起原生库直接走 classpath，但 -Djava.library.path 仍要求目录存在
  await fs.mkdir(base, { recursive: true });
  return base;
}

export async function buildLaunchArgs(instance: InstanceMeta): Promise<{ exe: string; args: string[] }> {
  const paths = getPaths();
  const versionId = instance.versionId && instance.versionId.length > 0 ? instance.versionId : instance.mcVersion;
  const json = await getVersionJson(versionId);
  const baseVersionId = await resolveBaseVersionId(versionId);
  const clientJar = join(versionDir(baseVersionId), baseVersionId + ".jar");
  if (!existsSync(clientJar)) throw new Error("缺少客户端 jar：" + clientJar + "，请先安装该版本");

  const classpath = [...classpathEntries(json), clientJar];
  const nativesDir = await resolveNativesDir(versionId, baseVersionId);
  const gameDir = resolveGameDir(instance);
  await fs.mkdir(gameDir, { recursive: true });
  await fs.mkdir(resolveModsDir(instance), { recursive: true });

  const settings = getSettings();
  const brand = launcherBrand();
  // 窗口尺寸/形态：实例自己的设置优先，没设置时沿用全局默认
  const window = resolveWindowSpec(instance);

  const identity = await resolveIdentity(instance);
  const assetIndexName = String(json.assetIndex?.id ?? json.assets ?? "legacy");
  if (!existsSync(join(paths.assetIndexes, assetIndexName + ".json"))) {
    log.warn("资源索引缺失：" + assetIndexName + ".json，游戏可能没有声音与语言文件");
  }

  const vars: Record<string, string> = {
    auth_player_name: identity.name,
    auth_uuid: identity.uuid,
    auth_access_token: identity.accessToken,
    auth_session: "token:" + identity.accessToken,
    // clientId 留给空串（与官方启动器一致），xuid 只有微软账号才有
    clientid: "",
    auth_xuid: identity.xuid,
    user_type: identity.userType,
    user_properties: "{}",
    profile_name: identity.profileName,
    version_name: versionId,
    version_type: String(json.type ?? "release"),
    game_directory: gameDir,
    game_assets: paths.assets,
    assets_root: paths.assets,
    assets_index_name: assetIndexName,
    natives_directory: nativesDir,
    launcher_name: brand,
    launcher_version: LAUNCHER_VERSION,
    classpath: classpath.join(";"),
    classpath_separator: ";",
    library_directory: paths.libraries,
    resolution_width: String(window.width),
    resolution_height: String(window.height),
    quickPlayPath: "",
    quickPlaySingleplayer: "",
    quickPlayMultiplayer: "",
    quickPlayRealms: "",
  };

  const modern = Array.isArray(json.arguments?.game) && json.arguments.game.length > 0;
  const jvmTemplates = argumentValues(json.arguments?.jvm, LAUNCH_FEATURES);
  const gameTemplates = modern
    ? argumentValues(json.arguments.game, LAUNCH_FEATURES)
    : typeof json.minecraftArguments === "string"
      ? splitArgs(json.minecraftArguments)
      : [];

  const missing = [...new Set([...jvmTemplates, ...gameTemplates].flatMap((template) => missingPlaceholders(template, vars)))];
  if (missing.length > 0) log.warn("启动参数存在未解析变量：" + missing.join(", "));

  // 老版本 JSON 没有 arguments.jvm，需要自己补 -Djava.library.path 与 -cp
  const jvmSource = jvmTemplates.length > 0
    ? jvmTemplates
    : ["-Djava.library.path=${natives_directory}", "-cp", "${classpath}"];
  const jvmArgs = jvmSource.map((template) => substitute(template, vars));

  // 官方 JSON 通过 logging.client.argument 指定 log4j 配置，缺少时游戏用内置默认值
  const logArgument = json.logging?.client?.argument;
  const logConfigId = json.logging?.client?.file?.id;
  if (typeof logArgument === "string" && logArgument.length > 0) {
    // 合并后的 JSON 已继承父级 logging，所以 id 天然覆盖版本继承路径
    const logConfigPath = logConfigId ? join(paths.assets, "log_configs", String(logConfigId)) : "";
    // 只做本地存在性判断，不发网络请求：文件缺失时传不存在的路径只会让 log4j 多报一行错
    if (logConfigPath.length > 0 && existsSync(logConfigPath)) {
      jvmArgs.push(substitute(logArgument, { ...vars, path: logConfigPath }));
    } else {
      log.warn("未找到 log4j 配置（" + String(logConfigId ?? "未知 id") + "），使用游戏内置默认配置");
    }
  }

  // 第三方账号：必须通过 -javaagent 注入 authlib-injector，否则客户端不会走该 API 校验/进服
  const injectorArgs: string[] = [];
  if (identity.yggdrasilApiUrl) {
    const supported = authlibInjectorSupported(instance.mcVersion);
    if (supported === false) {
      // 不注入也不报错中断：注入一个跑不起来的 javaagent 会直接让 JVM 崩在 premain，
      // 而按原版启动至少还能进离线服，所以这里只 warn 并跳过（版本判断见 authlibInjectorSupported）
      log.warn(
        "该版本（" + instance.mcVersion + "）低于 1.7.10，authlib-injector 无法注入，已跳过：第三方账号只能进离线服；" +
          "需要联机请改用 1.7.10 及以上版本",
      );
    } else {
      if (supported === null) log.warn("无法判断版本 " + instance.mcVersion + " 是否支持 authlib-injector，按支持处理");
      let jar: string;
      try {
        jar = (await ensureAuthlibInjector()).path;
      } catch (err) {
        // 静默降级会让玩家以为自己在用第三方账号，实际进服必失败，所以这里直接中断
        throw new Error("下载 authlib-injector 失败，第三方账号无法登录：" + (err instanceof Error ? err.message : String(err)));
      }
      injectorArgs.push(authlibInjectorArg(jar, identity.yggdrasilApiUrl));
      log.info("已注入 authlib-injector：" + jar + " → API " + identity.yggdrasilApiUrl);
    }
  } else if (identity.offlineAccountId) {
    // 离线账号：用本地皮肤 API 让游戏自己取皮肤/披风（不需要装模组）；失败只 warn
    injectorArgs.push(...(await offlineLocalSkinInjection(instance, identity)));
  }

  const extraJvmArgs = splitArgs(instance.extraJvmArgs ?? "");
  // 原版 JVM 模板本身就带 -Dminecraft.launcher.brand/version（值来自 launcher_name/launcher_version），
  // 只有模板缺这两个属性时才补，避免重复 -D；玩家自定义 JVM 参数放在后面，仍可覆盖
  const identityArgs = [
    ...(jvmArgs.some((arg) => arg.startsWith("-Dminecraft.launcher.brand=")) ? [] : ["-Dminecraft.launcher.brand=" + brand]),
    ...(jvmArgs.some((arg) => arg.startsWith("-Dminecraft.launcher.version=")) ? [] : ["-Dminecraft.launcher.version=" + LAUNCHER_VERSION]),
  ];
  // -javaagent 放在最前面：必须在主类之前进入 JVM，也不必和内存参数抢位置
  const jvm = [
    ...injectorArgs,
    ...jvmTuningArgs(instance.memoryMb ?? 2048, getSettings().memoryOptimize !== false),
    ...identityArgs,
    ...extraJvmArgs,
    ...jvmArgs,
  ];

  const gameArgs = gameTemplates.map((template) => substitute(template, vars));
  // 老版本 JSON 没有 --clientId/--xuid 占位符，微软账号需要补上（xuid 有值才补）
  if (identity.userType === "msa") {
    if (!gameArgs.includes("--clientId")) gameArgs.push("--clientId", "");
    if (identity.xuid.length > 0 && !gameArgs.includes("--xuid")) gameArgs.push("--xuid", identity.xuid);
  }
  if (modern) {
    gameArgs.push("--width", String(window.width), "--height", String(window.height));
    // 全屏：1.13 起（arguments.game 时代）的 Main 都接受 --fullscreen；1.12 及更早靠 options.txt 的 fullscreen 键兜底
    if (window.fullscreen) gameArgs.push("--fullscreen");
  }

  const mainClass = typeof json.mainClass === "string" ? json.mainClass : "";
  if (mainClass.length === 0) throw new Error("版本 JSON 缺少 mainClass：" + versionId);

  const exe = await resolveExecutable(instance);
  return { exe, args: [...jvm, mainClass, ...gameArgs] };
}

/**
 * 存档文件夹名会原样进命令行，且会被游戏拼成 saves/<名字>：
 * 含路径成分就有穿越风险，这里只做基本校验后原样传递。
 */
function assertLevelId(raw: string): string {
  const level = raw.trim();
  if (level.length === 0) throw new Error("存档名不能为空");
  if (/[\\/:*?"<>|]/.test(level) || level.includes("..") || level === ".") {
    throw new Error('非法存档名「' + raw + '」：不能包含 / \\ : * ? " < > | 或 .. 等路径成分');
  }
  return level;
}

/** null 表示版本号判断不了（快照/自定义版本 id），由调用方按「支持」处理并告警。 */
function versionSupportsQuickPlay(mcVersion: string): boolean | null {
  const match = /^(\d+)\.(\d+)/.exec(mcVersion.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== QUICK_PLAY_MIN_MAJOR) return major > QUICK_PLAY_MIN_MAJOR;
  return minor >= QUICK_PLAY_MIN_MINOR;
}

/**
 * 直接进入存档的启动参数，追加在参数末尾。
 * "__new__" 换成一定不存在的 level id：游戏自己新建世界并直接进入，最终文件夹名由游戏决定（简体中文下是「新的世界」），
 * 所以启动器不需要关心它最终叫什么。其它值按存档文件夹名原样传给 --quickPlaySingleplayer。
 */
function quickPlayArgs(instance: InstanceMeta, quickPlayLevel: string): string[] {
  const requested = quickPlayLevel.trim();
  const level = requested === QUICK_PLAY_NEW ? NEW_LEVEL_PREFIX + Date.now() : assertLevelId(requested);

  const supported = versionSupportsQuickPlay(instance.mcVersion);
  if (supported === false) throw new Error("该版本不支持直接进入存档（需要 1.20+）");
  if (supported === null) {
    log.warn("无法判断版本 " + instance.mcVersion + " 是否支持 --quickPlaySingleplayer，按支持处理");
  }

  log.info(
    requested === QUICK_PLAY_NEW
      ? "quickPlay 新建世界：--quickPlaySingleplayer " + level
      : "quickPlay 直接进入存档：--quickPlaySingleplayer " + level,
  );
  return ["--quickPlaySingleplayer", level];
}

/** 选 Java：实例指定优先，其次按设置决定是否自动匹配；不静默换 Java，免得玩家以为是启动器抽风。 */
async function resolveExecutable(instance: InstanceMeta): Promise<string> {
  const configured = (instance.javaPath ?? "").trim();
  if (configured.length > 0) {
    if (!existsSync(configured)) {
      throw new Error("实例指定的 Java 不存在：" + configured + "，请到实例设置里重新选择");
    }
    log.info("使用实例指定 Java：" + configured);
    return configured;
  }
  if (!getSettings().javaAutoMatch) {
    throw new Error("该实例未指定 Java，且已在设置里关闭「自动匹配 Java」，请到实例设置里选择");
  }
  return resolveJavaFor(instance.mcVersion);
}

const OPTIONS_FILE = "options.txt";

// 原版默认值，只写稳定键：实验性键会让玩家进游戏看到意外的设置
const DEFAULT_OPTIONS = [
  "lang:zh_cn",
  "autoJump:false",
  "fov:0.0",
  "gamma:1.0",
  "renderDistance:12",
  "guiScale:0",
  "particles:0",
  "maxFps:120",
  "fullscreen:false",
  "soundCategory_master:1.0",
  "soundCategory_music:1.0",
  "soundCategory_blocks:1.0",
  "soundCategory_entities:1.0",
  "soundCategory_players:1.0",
  "soundCategory_ambient:1.0",
  "soundCategory_weather:1.0",
  "soundCategory_ui:1.0",
];

export type LanguageSetupResult = "created" | "appended" | "already-zh" | "kept-user" | "forced";

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

/**
 * 简体中文界面。
 * forceChinese=true：无论玩家之前选了什么语言，都强制改回 lang:zh_cn（设置里的「强制中文」）。
 * forceChinese=false：只在玩家没选过语言时补一行，已有其它语言一律保留，不覆盖玩家选择。
 * 两种模式都只动 lang 这一行，其余键与顺序原样保留；写盘用临时文件 + rename。
 */
export async function ensureOptionsLanguage(
  gameDir: string,
  forceChinese: boolean = getSettings().forceChinese === true,
): Promise<LanguageSetupResult> {
  const file = join(gameDir, OPTIONS_FILE);
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  if (existing === null) {
    await fs.mkdir(gameDir, { recursive: true });
    await writeFileAtomic(file, DEFAULT_OPTIONS.join("\n") + "\n");
    return "created";
  }

  // 保留原文件的换行风格，避免整份 options.txt 从 CRLF 变成 LF
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith("lang:"));
  const current = index >= 0 ? lines[index].slice("lang:".length).trim() : null;

  if (current === "zh_cn") return "already-zh";

  if (forceChinese) {
    if (index >= 0) lines[index] = "lang:zh_cn";
    // 文件以换行结尾时 split 会多出一个空尾元素，插在它前面才不会多出空行
    else if (lines.length > 0 && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, "lang:zh_cn");
    else lines.push("lang:zh_cn");
    await writeFileAtomic(file, lines.join(eol));
    log.info("已按「强制中文」改写语言：" + String(current ?? "未设置") + " → zh_cn · " + file);
    return "forced";
  }

  if (current !== null) {
    log.info("玩家已把语言设为 " + current + "，保持不动：" + file);
    return "kept-user";
  }

  // 只追加一行，原有键与顺序原样保留
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : eol;
  await writeFileAtomic(file, existing + separator + "lang:zh_cn" + eol);
  return "appended";
}

/**
 * 实例显式选了窗口/全屏就写进 options.txt：游戏退出时会把窗口状态写回这个文件，
 * 不每次覆盖的话「从全屏切回窗口」这类改动下次启动就失效了。
 */
export async function applyWindowOptions(gameDir: string, fullscreen: boolean): Promise<void> {
  const file = join(gameDir, OPTIONS_FILE);
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  // 文件不存在时由 ensureOptionsLanguage 先建默认（默认里已有 fullscreen:false）
  if (existing === null) return;

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith("fullscreen:"));
  const wanted = "fullscreen:" + (fullscreen ? "true" : "false");
  if (index >= 0) {
    if (lines[index] === wanted) return;
    lines[index] = wanted;
  } else if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.splice(lines.length - 1, 0, wanted);
  } else {
    lines.push(wanted);
  }
  await writeFileAtomic(file, lines.join(eol));
  log.info("已按实例窗口设置写入 " + wanted + " · " + file);
}

const PROCESS_HELPER_SCRIPT = "# NaiWa Launcher：设置游戏进程优先级，并把游戏窗口标题改成启动器指定的名字。\n# Node 没有 Win32 FFI 也不能加依赖，所以用 PowerShell 调系统接口，只用于这一次启动。\n# 本文件由 launch.ts 以 UTF-8(BOM) 写出：PowerShell 5.1 无 BOM 会把中文注释按 GBK 解析导致语法错误。\nparam([int]$TargetPid, [string]$Priority = 'normal', [string]$Title = '', [string]$LogPath = '')\n$ErrorActionPreference = 'SilentlyContinue'\nfunction Note([string]$msg) {\n  if ($LogPath) { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + ' ' + $msg) }\n}\nfunction SetPrio([string]$class) {\n  try { (Get-Process -Id $TargetPid).PriorityClass = $class } catch { }\n  (Get-Process -Id $TargetPid).PriorityClass\n}\nNote ('start pid=' + $TargetPid + ' priority=' + $Priority + ' title=' + $Title)\n$map = @{ low = 'Idle'; normal = 'Normal'; high = 'High' }\n$class = $map[$Priority]\nif (-not $class) { $class = 'Normal' }\n# 游戏进程刚 spawn 出来时可能还查不到，重试等它出现在进程表里\n$proc = $null\nfor ($i = 0; $i -lt 100; $i++) {\n  $proc = Get-Process -Id $TargetPid\n  if ($proc) { break }\n  Start-Sleep -Milliseconds 100\n}\nif (-not $proc) { Note 'process not found'; exit 1 }\nNote ('priority first attempt -> ' + (SetPrio $class))\n# 等窗口出现：游戏初始化结束的时刻，它会把进程优先级重置回 Normal，必须在那之后再设一次\n$hasWindow = $false\nfor ($i = 0; $i -lt 240; $i++) {\n  $p = Get-Process -Id $TargetPid\n  if (-not $p) { Note 'process gone before window'; exit 0 }\n  if ($p.MainWindowTitle) { $hasWindow = $true; break }\n  Start-Sleep -Milliseconds 250\n}\nif ($hasWindow) { Note 'window appeared' } else { Note 'no window within 60s' }\n$final = SetPrio $class\nNote ('priority after window -> ' + $final)\nfor ($i = 0; $i -lt 10 -and $final -ne $class; $i++) {\n  Start-Sleep -Milliseconds 300\n  $final = SetPrio $class\n  Note ('priority retry ' + ($i + 1) + ' -> ' + $final)\n}\nif ([string]::IsNullOrEmpty($Title)) { Note 'no title requested'; exit 0 }\ntry {\n  Add-Type -TypeDefinition @'\nusing System;\nusing System.Collections.Generic;\nusing System.Runtime.InteropServices;\npublic static class NaiWaWindow {\n  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);\n  [DllImport(\"user32.dll\")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);\n  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern bool SetWindowText(IntPtr hWnd, string text);\n  [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\n  [DllImport(\"user32.dll\")] private static extern bool IsWindowVisible(IntPtr hWnd);\n  public static int Rename(uint target, string title) {\n    List<IntPtr> found = new List<IntPtr>();\n    EnumWindows(delegate(IntPtr h, IntPtr l) {\n      uint pid;\n      GetWindowThreadProcessId(h, out pid);\n      if (pid == target && IsWindowVisible(h)) found.Add(h);\n      return true;\n    }, IntPtr.Zero);\n    int count = 0;\n    foreach (IntPtr h in found) { if (SetWindowText(h, title)) count++; }\n    return count;\n  }\n}\n'@\n  Note 'win32 helper compiled'\n} catch { Note ('Add-Type failed: ' + $_.Exception.Message); exit 3 }\n# 游戏会把自己的标题写回 \"Minecraft* <版本>\"，持续改名直到标题稳定（最多 60 秒）\n$applied = 0\n$stable = 0\nfor ($i = 0; $i -lt 240; $i++) {\n  if (-not (Get-Process -Id $TargetPid)) { Note 'process gone while waiting for title'; exit 0 }\n  $n = [NaiWaWindow]::Rename([uint32]$TargetPid, $Title)\n  if ($n -gt 0) {\n    $applied++\n    if ($applied -eq 1) { Note ('window title set on ' + $n + ' window(s)') }\n  }\n  if (($i % 8) -eq 0) { $null = SetPrio $class }\n  $current = (Get-Process -Id $TargetPid).MainWindowTitle\n  if ($current -eq $Title) { $stable++ } else { $stable = 0 }\n  if ($stable -ge 4) { Note ('window title stable: ' + $current + ' (applied ' + $applied + ' times)'); break }\n  Start-Sleep -Milliseconds 250\n}\nNote ('final priority -> ' + (SetPrio $class))\nexit 0\n";

const PRIORITY_LABEL: Record<ProcessPriority, string> = {
  low: "Idle（低）",
  normal: "Normal（普通）",
  high: "High（高）",
};

/**
 * 进程优先级与窗口标题都只能靠 Win32 接口改，Node 没有 FFI 又不能加依赖，
 * 所以启动后旁挂一个 PowerShell 一次性助手（不阻塞游戏启动）。
 * 返回实际执行的命令，用于日志留痕。
 */
async function applyProcessSettings(pid: number, priority: ProcessPriority, title: string): Promise<string> {
  const dir = join(getPaths().dataRoot, "cache");
  const script = join(dir, "process-setup.ps1");
  await fs.mkdir(dir, { recursive: true });
  // 内容变了才重写，避免多次启动互相踩同一个文件；BOM 让 PowerShell 5.1 按 UTF-8 解析中文注释
  const content = "\uFEFF" + PROCESS_HELPER_SCRIPT;
  const current = await fs.readFile(script, "utf8").catch(() => null);
  if (current !== content) await fs.writeFile(script, content, "utf8");

  const helperArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", script,
    "-TargetPid", String(pid),
    "-Priority", priority,
  ];
  if (title.length > 0) helperArgs.push("-Title", title);
  // 助手自己的执行结果（设优先级/改标题/失败原因）也落盘，方便排查
  const helperLog = join(getPaths().logs, "process-setup.log");
  helperArgs.push("-LogPath", helperLog);

  // 不能 detached：PowerShell 5.1 在 DETACHED_PROCESS（没有控制台）下会立刻退出、什么也不做。
  // 助手寿命只有几百毫秒到一分钟，作为普通子进程即可；unref 保证启动器退出不被它拖住。
  const helper = spawn("powershell.exe", helperArgs, { detached: false, stdio: "ignore", windowsHide: true });
  helper.on("error", (err) => log.warn("进程设置助手启动失败：" + err.message));
  helper.unref();

  const shown = ["powershell.exe", ...helperArgs].map((part) => (/\s/.test(part) ? '"' + part + '"' : part)).join(" ");
  return shown;
}

/**
 * quickPlayLevel：存档文件夹名 → 直接进入该存档；"__new__" → 游戏新建世界并进入；不传则进标题画面。
 */
export async function launchInstance(id: string, quickPlayLevel?: string): Promise<void> {
  const instance = await getInstance(id);
  if (!instance) throw new Error("实例不存在：" + id);
  const settings = getSettings();
  // 并发上限要在解析 Java/建目录之前就判掉，否则用户会等半天才看到错误
  assertGameSlot(instance.id, instance.name, settings.gameInstanceLimit ?? "one");

  // 先校验 quickPlay：存档名非法或版本太老要在解析 Java、创建目录之前就报错
  const requested = (quickPlayLevel ?? "").trim();
  const quickPlay = requested.length > 0 ? quickPlayArgs(instance, requested) : [];

  const { exe, args } = await buildLaunchArgs(instance);
  // 追加在参数末尾：游戏用 joptsimple 解析，顺序无关，放最后不干扰 --width/--height 等模板参数
  args.push(...quickPlay);

  const paths = getPaths();
  const gameDir = resolveGameDir(instance);
  await fs.mkdir(gameDir, { recursive: true });
  await fs.mkdir(resolveModsDir(instance), { recursive: true });
  await fs.mkdir(paths.logs, { recursive: true });

  const language = await ensureOptionsLanguage(gameDir, settings.forceChinese === true);
  if (language === "created" || language === "appended") log.info("已把界面语言初始化为简体中文（" + language + "）");
  else if (language === "forced") log.info("已按「强制中文」把语言改回 zh_cn：" + join(gameDir, OPTIONS_FILE));

  // 实例显式选了窗口形态才覆盖 options.txt；"跟随设置" 时不动玩家自己的全屏开关
  const windowSpec = resolveWindowSpec(instance);
  if (windowSpec.explicit) await applyWindowOptions(gameDir, windowSpec.fullscreen);

  // 本地皮肤：只有该账号选过皮肤才写文件，任何失败都只记日志（绝不阻断启动）
  const skinAccount = await getActiveAccount();
  if (skinAccount) {
    try {
      const applied = await applyToInstance(instance.id, skinAccount.id);
      if (applied.applied) {
        log.info("启动前已应用本地皮肤：" + (applied.skinFile ?? "") + (applied.modInstalled ? "" : "（实例未装 CustomSkinLoader，需先安装才生效）"));
      } else if (applied.message) {
        log.info("本地皮肤未应用：" + applied.message);
      }
    } catch (err) {
      log.warn("应用本地皮肤失败（不影响启动）：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  const title = resolveWindowTitle(instance);
  const priority: ProcessPriority = settings.processPriority ?? "normal";

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(paths.logs, instance.id + "-" + stamp + ".log");
  const stream = createWriteStream(logPath, { flags: "a" });
  const write = (text: string): void => {
    stream.write(text);
  };
  // 参数按数组交给 spawn，含空格/引号的参数由 Node 自己按 Windows 规则转义，不拼命令行
  const child = spawn(exe, args, {
    cwd: gameDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  const pid = child.pid ?? 0;
  // 记进「正在运行」表：exit/error 时移除，表只在本进程内有效（见 runningGames 注释）
  runningGames.set(instance.id, { child, name: instance.name });
  const releaseSlot = (): void => {
    runningGames.delete(instance.id);
  };

  write("# " + new Date().toISOString() + " NaiWa Launcher 启动 " + instance.name + "\r\n");
  write("# 版本隔离: " + (settings.versionIsolation === "none" ? "none（共用 .minecraft）" : "all（每实例独立）") + "\r\n");
  write("# gameDir: " + gameDir + "\r\n");
  write("# options.txt: " + join(gameDir, OPTIONS_FILE) + "（" + language + "）\r\n");
  write("# windowTitle: " + title + "\r\n");
  write(
    "# window: " + (windowSpec.fullscreen ? "全屏" : "窗口 " + windowSpec.width + "x" + windowSpec.height) +
      (windowSpec.explicit ? "" : "（跟随全局设置）") + "\r\n",
  );
  write("# pid: " + String(pid) + "\r\n");
  write("# exe: " + exe + "\r\n");
  if (quickPlay.length > 0) write("# quickPlay: " + quickPlay.join(" ") + "\r\n");
  write("# args: " + args.join(" ") + "\r\n");
  child.stdout?.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
  child.on("error", (err) => {
    write("# 启动失败：" + err.message + "\r\n");
    log.error("启动失败：" + err.message);
    releaseSlot();
    stream.end();
  });
  child.on("exit", (code) => {
    write("# 进程已退出，code=" + String(code) + "\r\n");
    releaseSlot();
    stream.end();
    if (code !== 0) log.warn("游戏进程退出码 " + String(code) + "，详见 " + logPath);
  });
  // 分离：主进程退出不影响游戏；日志通过管道继续落盘
  child.unref();

  log.info(
    "启动方式：spawn（" + exe + "）detached，参数以数组传递；工作目录 " + gameDir +
      "；优先级 " + priority + "（" + PRIORITY_LABEL[priority] + "）由 PowerShell 设置",
  );
  // 旁挂 PowerShell 改优先级/窗口标题属于「操作其它进程」的敏感行为，默认关闭以减少误报
  const tweakProcess = settings.advancedProcessTweaks === true;
  if (!tweakProcess) {
    log.info("已跳过进程设置助手（设置里「高级进程操作」未开启，默认关闭以降低杀毒误报）");
  }
  if (tweakProcess && pid > 0 && process.platform === "win32") {
    try {
      const command = await applyProcessSettings(pid, priority, title);
      write("# priority/title helper: " + command + "\r\n");
      log.info("进程设置助手：" + command);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      write("# priority/title helper 失败：" + reason + "\r\n");
      log.warn("进程设置助手失败（游戏已启动，仅优先级/标题未生效）：" + reason);
    }
  }

  await updateInstance(instance.id, { lastPlayedAt: Date.now() });
  log.info("已启动「" + instance.name + "」，日志：" + logPath);
}
