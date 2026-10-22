import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Account } from "../../shared/types";
import { downloadFile } from "../core/http";
import { logger, registerSecret } from "../core/logger";
import { getPaths } from "../core/paths";
import { getAccount, updateYggdrasilTokens, upsertYggdrasilAccount } from "./accounts";

const log = logger("yggdrasil");

const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const TIMEOUT_MS = 20_000;
/** 元数据探测是登录前的额外一跳，超时要短：探测失败不影响后续用用户填的地址去登录。 */
const META_TIMEOUT_MS = 12_000;
/** authlib-injector 官方产物索引。 */
const INJECTOR_LATEST_URL = "https://authlib-injector.yushi.moe/artifact/latest.json";
const INJECTOR_USER_AGENT = "NaiWaLauncher/0.1 (authlib-injector)";
/** authlib-injector 支持的最低游戏版本（其 README 声明的下限）。 */
const MIN_MC_MAJOR = 1;
const MIN_MC_MINOR = 7;
const MIN_MC_PATCH = 10;

type Json = Record<string, any>;

interface Reply {
  status: number;
  json: Json | null;
  text: string;
}

/** 第三方服务端公开的元数据（GET {apiUrl} 的返回）。 */
export interface EndpointMeta {
  serverName: string;
  signaturePublickey: string;
  skinDomains: string[];
}

/** IPC 契约：accounts:validateYggdrasil。 */
export interface YggdrasilValidation {
  ok: boolean;
  name?: string;
  uuid?: string;
  error?: string;
  /** 令牌已失效、本次通过 /authserver/refresh 续期成功。 */
  refreshed?: boolean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 直接用 fetch 而不是 core/http 的 fetchJson：Yggdrasil 的失败是「非 2xx + errorMessage」，
 * fetchJson 会把响应体丢掉，就翻不出「账号或密码错误」这类可读提示了。
 */
async function request(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS, attempts = 1): Promise<Reply> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers ?? {}) },
      });
      const text = await res.text();
      let json: Json | null = null;
      try {
        json = text ? (JSON.parse(text) as Json) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    } catch (err) {
      last = err instanceof Error && err.name === "AbortError" ? new Error("请求超时（" + timeoutMs + "ms）") : err;
      // 只重试幂等的 GET：登录/续期重复发送会触发服务端的频率限制
      if (attempt < attempts) await sleep(400 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("网络请求失败：" + describe(last) + " · " + url);
}

function postJson(url: string, body: unknown): Promise<Reply> {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 规范化用户填的 API 地址：
 * - 缺协议补 https
 * - 去掉尾部斜杠与查询串（后面要拼 /authserver/xxx，带查询串会拼坏）
 * - 只填域名 / 站点根时按 authlib-injector 约定补 /api/yggdrasil
 */
export function normalizeApiUrl(raw: string): string {
  const input = (raw ?? "").trim();
  if (input.length === 0) throw new Error("请填写第三方登录 API 地址（例如 https://littleskin.cn/api/yggdrasil）");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : "https://" + input;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("API 地址格式不正确：" + input);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API 地址必须使用 http(s)：" + input);
  }
  const path = url.pathname.replace(/\/+$/, "");
  // 空路径（站点根）与常见的 /api/yggdrasil 都归一到标准端点
  const apiPath = path.length === 0 ? "/api/yggdrasil" : path;
  return url.origin + apiPath;
}

/** 读服务端元数据；不是合法的 Yggdrasil 端点（没有 signaturePublickey / meta）时返回 null。 */
async function readMeta(apiUrl: string): Promise<EndpointMeta | null> {
  const reply = await request(apiUrl, { method: "GET" }, META_TIMEOUT_MS, 2);
  if (reply.status !== 200 || !reply.json) return null;
  const body = reply.json;
  const meta: Json = body.meta && typeof body.meta === "object" ? (body.meta as Json) : {};
  const signaturePublickey = str(body.signaturePublickey);
  if (!signaturePublickey && Object.keys(meta).length === 0) return null;
  return {
    serverName: str(meta.serverName) || str(meta.implementationName),
    signaturePublickey,
    skinDomains: Array.isArray(body.skinDomains) ? body.skinDomains.map(String) : [],
  };
}

/**
 * 定出真正要用的 API 根地址：
 * 先探测用户填的地址；探测失败时退回同站点的标准端点 <origin>/api/yggdrasil
 * （用户可能只填了域名、或填成了皮肤站首页）；两者都不通就保留用户写的地址，
 * 让 authenticate 报出服务端真实错误，而不是在探测阶段编一个。
 */
async function resolveEndpoint(raw: string): Promise<{ apiUrl: string; meta: EndpointMeta | null }> {
  const primary = normalizeApiUrl(raw);
  const candidates = [primary];
  const standard = new URL(primary).origin + "/api/yggdrasil";
  if (standard !== primary) candidates.push(standard);
  for (const candidate of candidates) {
    const meta = await readMeta(candidate).catch(() => null);
    if (meta) return { apiUrl: candidate, meta };
  }
  return { apiUrl: primary, meta: null };
}

/** 常见 Yggdrasil 错误码 → 用户看得懂的中文（原始 errorMessage 仍保留在文案里）。 */
const ERROR_HINTS: Record<string, string> = {
  // 规范里的拼写就是 InvaildCredentialsException（历史拼写错误），两种都收
  InvaildCredentialsException: "账号或密码错误",
  InvalidCredentialsException: "账号或密码错误",
  ForbiddenOperationException: "登录过于频繁或该账号被限制",
  IllegalUserNameException: "用户名不合法：请确认使用的是皮肤站的邮箱/玩家名",
  IllegalArgumentException: "服务端拒绝了这个请求，请确认填的是 Yggdrasil API 地址",
  ContactAdminException: "该操作被服务器禁止，请联系皮肤站管理员",
  UnsupportedMediaTypeException: "服务端不接受 JSON 请求体，这个地址可能不是 Yggdrasil API",
};

/** 令牌类接口（validate / refresh）的失败文案：这些不是「登录」失败，别套登录提示。 */
function tokenFailure(reply: Reply, endpoint: string): string {
  const body: Json = reply.json ?? {};
  const error = str(body.error);
  const message = str(body.errorMessage) || str(body.message) || reply.text.slice(0, 200).trim();
  if (!error && !message) return "校验请求失败：HTTP " + reply.status + " · " + endpoint;
  return "令牌无效或已过期" + (message ? "（" + message + "）" : "") + (error ? " · " + error : "");
}

/** 把「非 2xx + errorMessage」压成一句可读中文，原文一律保留便于排查。 */
function authFailure(reply: Reply, endpoint: string): string {
  const body: Json = reply.json ?? {};
  const error = str(body.error);
  const message = str(body.errorMessage) || str(body.message) || reply.text.slice(0, 200).trim();
  const hint = ERROR_HINTS[error];
  if (hint) return hint + (message ? "（" + message + "）" : "") + (error ? " · " + error : "");
  if (error || message) {
    return "第三方登录失败：HTTP " + reply.status + (error ? " · " + error : "") + (message ? " · " + message : "");
  }
  // 不是 JSON：地址填错了（常见是填成皮肤站首页，返回一坨 HTML）
  return (
    "该地址不是可用的 Yggdrasil 服务端（HTTP " + reply.status + "）：" + endpoint +
    "；请确认填的是 API 根地址，例如 https://littleskin.cn/api/yggdrasil"
  );
}

/** clientToken 持久化：authlib-injector 规范要求同一启动器复用同一个 clientToken。 */
function clientTokenFile(): string {
  return join(getPaths().config, "yggdrasil.json");
}

async function ensureClientToken(): Promise<string> {
  const file = clientTokenFile();
  const text = await readFile(file, "utf8").catch(() => null);
  if (text) {
    try {
      const parsed = JSON.parse(text) as Json;
      const saved = str(parsed.clientToken).trim();
      if (saved.length >= 8) return saved;
    } catch {
      log.warn("第三方 clientToken 文件损坏，已重新生成：" + file);
    }
  }
  const token = randomUUID();
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify({ clientToken: token }, null, 2) + "\n", "utf8");
  await rename(tmp, file);
  return token;
}

function normalizeProfileUuid(raw: string): string {
  const hex = String(raw ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 32) throw new Error("服务端返回的角色 UUID 不合法：" + raw);
  return hex;
}

/**
 * authenticate 返回的角色列表：有 availableProfiles 就全存（用于角色切换），
 * 服务端只给 selectedProfile 时也存一条，保证列表至少含当前角色。
 */
function collectProfiles(body: Json, selected: { id: string; name: string }): { id: string; name: string }[] {
  const raw = Array.isArray(body.availableProfiles) ? (body.availableProfiles as Json[]) : [];
  const picked: { id: string; name: string }[] = [{ id: selected.id, name: selected.name }];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const hex = str(item.id).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    const name = str(item.name);
    if (hex.length !== 32 || !name) continue;
    if (picked.some((p) => p.id === hex)) continue;
    picked.push({ id: hex, name });
  }
  return picked;
}

/**
 * 第三方（Yggdrasil / authlib-injector）登录：authenticate → 落盘账号。
 * 成功后再读一次站点根拿 serverName 作为 siteName（失败忽略，不影响登录结果）。
 */
export async function loginYggdrasil(apiUrl: string, username: string, password: string): Promise<Account> {
  const user = (username ?? "").trim();
  if (user.length === 0) throw new Error("请填写第三方账号的用户名（邮箱或玩家名）");
  if ((password ?? "").length === 0) throw new Error("请填写第三方账号的密码");

  const endpoint = await resolveEndpoint(apiUrl);
  const clientToken = await ensureClientToken();
  const reply = await postJson(endpoint.apiUrl + "/authserver/authenticate", {
    username: user,
    password,
    clientToken,
    agent: { name: "Minecraft", version: 1 },
    requestUser: true,
  });
  if (reply.status !== 200) throw new Error(authFailure(reply, endpoint.apiUrl));

  const body: Json = reply.json ?? {};
  const accessToken = str(body.accessToken);
  if (accessToken.length === 0) throw new Error("登录响应缺少 accessToken · " + endpoint.apiUrl);
  const profile: Json = body.selectedProfile && typeof body.selectedProfile === "object" ? (body.selectedProfile as Json) : {};
  const profileName = str(profile.name);
  if (str(profile.id).length === 0 || profileName.length === 0) {
    throw new Error("该账号还没有游戏角色（selectedProfile 为空），请先到皮肤站创建角色再登录");
  }
  registerSecret(accessToken);

  const selectedId = normalizeProfileUuid(str(profile.id));
  const meta = endpoint.meta ?? (await readMeta(endpoint.apiUrl).catch(() => null));
  const account = await upsertYggdrasilAccount({
    apiUrl: endpoint.apiUrl,
    name: profileName,
    uuid: selectedId,
    profiles: collectProfiles(body, { id: selectedId, name: profileName }),
    accessToken,
    clientToken: str(body.clientToken) || clientToken,
    // Yggdrasil 的令牌不返回过期时间，有效性只能靠 /authserver/validate 判断 → 0 表示「未知/不失效」
    expiresAt: 0,
    siteName: meta?.serverName ?? "",
  });
  log.info(
    "第三方账号登录成功：" + account.name + (meta?.serverName ? "（" + meta.serverName + "）" : "") + " · " + endpoint.apiUrl,
  );
  return account;
}

interface TokenCheck {
  ok: boolean;
  accessToken: string;
  error?: string;
}

/** validate → 401 时 refresh 一次。返回可用于启动的最新 accessToken。 */
async function checkToken(account: Account): Promise<TokenCheck> {
  const ygg = account.yggdrasil;
  if (!ygg) return { ok: false, accessToken: "", error: "该账号没有第三方登录令牌，请重新登录" };
  const validate = await postJson(ygg.apiUrl + "/authserver/validate", {
    accessToken: ygg.accessToken,
    clientToken: ygg.clientToken,
  });
  // 规范要求 204；部分实现返回 200，两者都算有效
  if (validate.status === 200 || validate.status === 204) return { ok: true, accessToken: ygg.accessToken };
  if (validate.status !== 401 && validate.status !== 403) {
    // 5xx / 4xx 其它码不是令牌问题，别误导用户去重新登录
    return {
      ok: false,
      accessToken: ygg.accessToken,
      error: "校验请求被服务端拒绝：HTTP " + validate.status + " · " + ygg.apiUrl,
    };
  }

  const refresh = await postJson(ygg.apiUrl + "/authserver/refresh", {
    accessToken: ygg.accessToken,
    clientToken: ygg.clientToken,
    requestUser: true,
  });
  if (refresh.status !== 200) {
    return {
      ok: false,
      accessToken: ygg.accessToken,
      error: tokenFailure(refresh, ygg.apiUrl) + "；请重新登录该账号",
    };
  }
  const body: Json = refresh.json ?? {};
  const accessToken = str(body.accessToken);
  if (accessToken.length === 0) {
    return { ok: false, accessToken: ygg.accessToken, error: "续期响应缺少 accessToken · " + ygg.apiUrl };
  }
  registerSecret(accessToken);
  await updateYggdrasilTokens(account.id, {
    accessToken,
    clientToken: str(body.clientToken) || ygg.clientToken,
    // 续期后有效期依旧未知，保持语义「0 = 不失效，靠 validate 判断」
    expiresAt: 0,
  });
  log.info("第三方令牌已续期：" + account.name + " · " + ygg.apiUrl);
  return { ok: true, accessToken };
}

/** IPC：校验第三方账号的令牌，401 时自动续期一次。 */
export async function validateYggdrasilAccount(id: string): Promise<YggdrasilValidation> {
  const account = await getAccount(id);
  if (!account) return { ok: false, error: "账号不存在：" + id };
  if (account.type !== "yggdrasil" || !account.yggdrasil) return { ok: false, error: "该账号不是第三方（Yggdrasil）账号" };
  try {
    const fresh = account.yggdrasil.accessToken;
    const check = await checkToken(account);
    if (!check.ok) return { ok: false, error: check.error ?? "令牌校验失败" };
    return {
      ok: true,
      name: account.name,
      uuid: account.uuid,
      ...(check.accessToken !== fresh ? { refreshed: true } : {}),
    };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/**
 * 启动用：拿到可用的 accessToken（失效则续期一次）。
 * 网络不通时不阻塞启动：继续用已存令牌（离线服仍可进），由日志提示用户。
 */
export async function resolveYggdrasilSession(
  account: Account,
): Promise<{ accessToken: string; clientToken: string; uuid: string; name: string }> {
  const ygg = account.yggdrasil;
  if (account.type !== "yggdrasil" || !ygg?.accessToken) throw new Error("该账号没有第三方登录令牌，请重新登录");
  try {
    const check = await checkToken(account);
    if (!check.ok) {
      log.warn("第三方令牌校验失败（" + String(check.error) + "），仍用已存令牌启动；进入第三方服务器被踢请重新登录该账号");
    }
    return {
      accessToken: check.ok ? check.accessToken : ygg.accessToken,
      clientToken: ygg.clientToken,
      uuid: account.uuid,
      name: account.name,
    };
  } catch (err) {
    log.warn("第三方令牌校验请求失败（" + describe(err) + "），继续用已存令牌启动");
    return { accessToken: ygg.accessToken, clientToken: ygg.clientToken, uuid: account.uuid, name: account.name };
  }
}

/** authlib-injector 的落地路径：<NaiWa>/tools/authlib-injector.jar。 */
export function authlibInjectorPath(): string {
  return join(getPaths().dataRoot, "tools", "authlib-injector.jar");
}

function injectorSidecarPath(): string {
  return join(getPaths().dataRoot, "tools", "authlib-injector.json");
}

interface InjectorLatest {
  version: string;
  downloadUrl: string;
  sha256: string;
}

interface InjectorSidecar {
  version: string;
  sha256: string;
  size: number;
}

async function readSidecar(): Promise<InjectorSidecar | null> {
  const text = await readFile(injectorSidecarPath(), "utf8").catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Json;
    const size = Number(parsed.size);
    const sha256 = str(parsed.sha256).toLowerCase();
    if (!Number.isFinite(size) || size <= 0) return null;
    return { version: str(parsed.version), sha256, size };
  } catch {
    return null;
  }
}

async function writeSidecar(sidecar: InjectorSidecar): Promise<void> {
  const file = injectorSidecarPath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function fetchLatestInjector(): Promise<InjectorLatest | null> {
  const reply = await request(
    INJECTOR_LATEST_URL,
    { method: "GET", headers: { "user-agent": INJECTOR_USER_AGENT } },
    META_TIMEOUT_MS,
    2,
  );
  if (reply.status !== 200 || !reply.json) return null;
  const body = reply.json;
  const downloadUrl = str(body.download_url) || str(body.downloadUrl);
  if (downloadUrl.length === 0) return null;
  const checksums: Json = body.checksums && typeof body.checksums === "object" ? (body.checksums as Json) : {};
  return {
    version: str(body.version) || "未知",
    downloadUrl,
    sha256: str(checksums.sha256).toLowerCase(),
  };
}

/**
 * 保证 <NaiWa>/tools/authlib-injector.jar 存在且是最新版：
 * 侧车记录（版本 + sha256 + 大小）与远端一致、且本地大小一致时直接复用，不下载、不重算 hash。
 * 离线（拿不到 latest.json）时只要有现成 jar 就复用，避免每次启动都卡在网络等待上。
 */
export async function ensureAuthlibInjector(): Promise<{ path: string; version: string }> {
  const jar = authlibInjectorPath();
  const sidecar = await readSidecar();
  const latest = await fetchLatestInjector().catch((err: unknown) => {
    log.warn("读取 authlib-injector 版本信息失败（" + describe(err) + "），改用本地已有文件");
    return null;
  });

  const local = await stat(jar).catch(() => null);
  if (local && local.size > 0) {
    if (!latest) return { path: jar, version: sidecar?.version ?? "未知" };
    const sizeMatch = sidecar !== null && sidecar.size === local.size;
    if (latest.sha256.length > 0) {
      if (sidecar && sizeMatch && sidecar.sha256 === latest.sha256) {
        return { path: jar, version: latest.version };
      }
      const actual = await sha256Of(jar);
      if (actual === latest.sha256) {
        await writeSidecar({ version: latest.version, sha256: actual, size: local.size });
        return { path: jar, version: latest.version };
      }
      log.warn("本地 authlib-injector 与最新版不一致，重新下载（" + jar + "）");
    } else if (sizeMatch && sidecar?.version === latest.version) {
      return { path: jar, version: latest.version };
    }
  }

  if (!latest) throw new Error("无法获取 authlib-injector 下载地址，请检查网络后重试");
  await mkdir(dirname(jar), { recursive: true });
  // downloadFile 在目标已存在且无 sha1 时会直接复用旧文件，这里必须先删掉才能真的换新
  await rm(jar, { force: true });
  const { bytes } = await downloadFile(latest.downloadUrl, jar, { label: "authlib-injector" });
  if (latest.sha256.length > 0) {
    const actual = await sha256Of(jar);
    if (actual !== latest.sha256) {
      await rm(jar, { force: true });
      throw new Error("authlib-injector 校验失败：期望 sha256 " + latest.sha256 + "，实际 " + actual);
    }
  }
  await writeSidecar({ version: latest.version, sha256: latest.sha256, size: bytes });
  log.info("已下载 authlib-injector " + latest.version + "（" + bytes + " 字节）→ " + jar);
  return { path: jar, version: latest.version };
}

/** 启动参数：-javaagent:<jar>=<apiUrl>，必须出现在主类之前。 */
export function authlibInjectorArg(jarPath: string, apiUrl: string): string {
  return "-javaagent:" + jarPath + "=" + apiUrl;
}

/** 版本是否支持 authlib-injector；null 表示判断不了（快照/自定义版本 id）。 */
export function authlibInjectorSupported(mcVersion: string): boolean | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec((mcVersion ?? "").trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (major !== MIN_MC_MAJOR) return major > MIN_MC_MAJOR;
  if (minor !== MIN_MC_MINOR) return minor > MIN_MC_MINOR;
  return patch >= MIN_MC_PATCH;
}
