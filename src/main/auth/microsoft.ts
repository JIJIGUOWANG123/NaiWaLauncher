import type { Account, DeviceCodeChallenge, MicrosoftLoginState } from "../../shared/types";
import { logger, registerSecret } from "../core/logger";
import { systemFetch } from "../core/netfetch";
import { getSettings, loadSettings } from "../core/settings";
import { updateMicrosoftTokens, upsertMicrosoftAccount } from "./accounts";
import { mt } from "../core/i18n";

const log = logger("microsoft");

const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const DEVICE_CODE_URL = AUTHORITY + "/devicecode";
const TOKEN_URL = AUTHORITY + "/token";
const SCOPE = "XboxLive.signin offline_access";
const XBL_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";
const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const TIMEOUT_MS = 20_000;
/** 提前 60s 视为过期，避免令牌在请求途中失效。 */
const EXPIRY_SKEW_MS = 60_000;

/** 提示文案随语言变，所以做成函数（模块级常量会在读到设置之前就把语言定格）。 */
function missingClientIdHint(): string {
  return mt("auth.ms.missingClientId");
}

type Json = Record<string, any>;

interface Reply {
  status: number;
  json: Json | null;
  text: string;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface CachedSession {
  accessToken: string;
  expiresAt: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * fetch 在 Node/Electron 里失败时只给一句 "fetch failed"，真正的原因（证书链、DNS、连接被重置）
 * 藏在 err.cause 上。这里把它挖出来并把常见原因翻成人话，否则用户只能看到一个没法排查的字符串。
 */
function networkReason(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const code = cause?.code ?? "";
  const detail = cause?.message ?? "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code + " " + detail)) {
    return mt("auth.ms.tlsFail", { code });
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return mt("auth.ms.dnsFail", { code });
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code)) {
    return mt("auth.ms.connFail", { code });
  }
  return code ? mt("auth.ms.netError", { code }) : "";
}

/** 只对「可重试的网络错误」重试一次：用户手动点登录时不该被一次抖动打败。 */
function retryable(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const code = (cause?.code ?? "") + " " + (cause?.message ?? "");
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(code);
}

/**
 * 这里直接用 fetch 而不是 core/http 的 fetchJson：设备码轮询的“用户还没授权”是一次
 * HTTP 400 + error 字段的正常状态，而 fetchJson 在非 2xx 时会丢掉响应体，无法区分
 * authorization_pending / expired_token / AADSTS 错误码。
 */
async function request(url: string, init: RequestInit, attempt = 0): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // 走系统网络栈（系统代理 + Windows 证书库）：Node 自带 fetch 在企业网/HTTPS 拦截下会直接失败
    const res = await systemFetch(url, {
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
    const aborted = err instanceof Error && err.name === "AbortError";
    // 只在「拿到响应之前就断了」的情况重试一次；AbortError（我们自己超时）重试也大概率没用
    if (!aborted && attempt === 0 && retryable(err)) {
      clearTimeout(timer);
      log.warn(`[microsoft] 网络错误，重试一次：${networkReason(err) || messageOf(err)} · ${url}`);
      await new Promise((r) => setTimeout(r, 400));
      return request(url, init, attempt + 1);
    }
    const reason = aborted ? mt("core.requestTimeout", { ms: TIMEOUT_MS }) : [messageOf(err), networkReason(err)].filter(Boolean).join("; ");
    log.warn(`[microsoft] 请求失败：${reason} · ${url}`);
    throw new Error(reason + " · " + url);
  } finally {
    clearTimeout(timer);
  }
}

function postForm(url: string, form: Record<string, string>): Promise<Reply> {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

function postXbl(url: string, body: Json): Promise<Reply> {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xbl-contract-version": "1" },
    body: JSON.stringify(body),
  });
}

function aadstsCode(text: string): string {
  const found = /AADSTS\d+/.exec(text);
  return found ? found[0] : "";
}

/** 把 OAuth / Xbox / Minecraft 三类错误体统一压成一句可读的错误。 */
function describeFailure(reply: Reply): string {
  const body: Json = reply.json ?? {};
  const detail =
    (typeof body.error_description === "string" && body.error_description) ||
    (typeof body.errorMessage === "string" && body.errorMessage) ||
    (typeof body.Message === "string" && body.Message) ||
    "";
  const label =
    (typeof body.error === "string" && body.error) ||
    (typeof body.path === "string" && body.path) ||
    "";
  const code = aadstsCode(detail || reply.text);
  const head = label ? label + (code ? "（" + code + "）" : "") : "HTTP " + reply.status;
  const tail = detail ? detail.split("\r\n")[0].slice(0, 200) : reply.text.slice(0, 200);
  return head + (tail ? " · " + tail : "");
}

/** AADSTS 错误码 → 字典 key（码本身写进文案里，便于对照微软文档）。 */
const AADSTS_HINT_KEYS: Record<string, string> = {
  AADSTS70002: "auth.ms.aadsts70002",
  AADSTS700016: "auth.ms.aadsts700016",
  AADSTS700038: "auth.ms.aadsts700038",
  AADSTS7000014: "auth.ms.aadsts7000014",
  AADSTS7000012: "auth.ms.aadsts7000012",
  AADSTS54005: "auth.ms.aadsts54005",
};

/**
 * 拼错误文案：可操作提示在前，原始 OAuth 描述（含 AADSTS 码）在后。
 * 只要响应里带 AADSTS 码，成文里一定保留它。
 */
function failureText(prefix: string, reply: Reply): string {
  const detail = describeFailure(reply);
  const code = aadstsCode(detail) || aadstsCode(reply.text);
  const hintKey = AADSTS_HINT_KEYS[code];
  if (hintKey) return prefix + mt(hintKey) + " · " + detail;
  if (code) return prefix + detail;
  return prefix + "HTTP " + reply.status + (detail ? " · " + detail : "");
}

const XSTS_MESSAGE_KEYS: Record<number, string> = {
  2148916233: "auth.ms.xstsNoXboxAccount",
  2148916238: "auth.ms.xstsChildAccount",
  2148916235: "auth.ms.xstsRegionUnsupported",
};

/** XSTS 的 XErr 翻译成人话；未知码保留原始码便于排查。 */
export function xstsErrorMessage(xerr: number, detail?: string): string {
  const knownKey = XSTS_MESSAGE_KEYS[xerr];
  if (knownKey) return mt(knownKey);
  const suffix = detail ? "（" + detail.slice(0, 120) + "）" : "";
  return mt("auth.ms.xboxAuthFailed", { code: xerr, detail: suffix });
}

function xboxFailure(reply: Reply): string {
  const body: Json = reply.json ?? {};
  const xerr = Number(body.XErr ?? 0);
  if (Number.isFinite(xerr) && xerr > 0) {
    const detail = typeof body.Message === "string" && body.Message ? body.Message : undefined;
    return xstsErrorMessage(xerr, detail);
  }
  // Xbox 对无效 RPS 票据只回一个空体 401，翻译成用户能照做的动作
  if (reply.status === 401) return mt("auth.ms.credentialsExpired");
  return failureText(mt("auth.ms.failXbox"), reply);
}

async function requireClientId(): Promise<string> {
  // 缓存可能是默认值（未加载过设置），这里强制读盘，避免误报“没填 client id”
  await loadSettings();
  const clientId = getSettings().microsoftClientId.trim();
  if (!clientId) throw new Error(missingClientIdHint());
  return clientId;
}

function tokenSetFrom(body: Json, fallbackRefresh = ""): TokenSet {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh;
  const expiresIn = Number(body.expires_in) || 3600;
  if (accessToken) registerSecret(accessToken);
  if (refreshToken) registerSecret(refreshToken);
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

/** 第 1 环：微软 access token → Xbox Live token + user hash。 */
async function authenticateXbl(accessToken: string): Promise<{ token: string; uhs: string }> {
  const reply = await postXbl(XBL_AUTH_URL, {
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: "d=" + accessToken },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  const body: Json = reply.json ?? {};
  const token: unknown = body.Token;
  const uhs: unknown = body.DisplayClaims?.xui?.[0]?.uhs;
  if (reply.status !== 200 || typeof token !== "string" || typeof uhs !== "string") {
    throw new Error(xboxFailure(reply));
  }
  return { token, uhs };
}

/** 第 2 环：XSTS 授权（RelyingParty 指向 Minecraft services）。 */
async function authorizeXsts(xblToken: string): Promise<{ token: string; xuid: string }> {
  const reply = await postXbl(XSTS_URL, {
    Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT",
  });
  const body: Json = reply.json ?? {};
  const token: unknown = body.Token;
  if (reply.status !== 200 || typeof token !== "string") throw new Error(xboxFailure(reply));
  const xuid = body.DisplayClaims?.xui?.[0]?.xid;
  return { token, xuid: typeof xuid === "string" ? xuid : "" };
}

/** 第 3 环：XSTS token 换 Minecraft services access token。 */
async function loginWithXbox(uhs: string, xstsToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  const reply = await postXbl(MC_LOGIN_URL, { identityToken: "XBL3.0 x=" + uhs + ";" + xstsToken });
  const body: Json = reply.json ?? {};
  const accessToken: unknown = body.access_token;
  if (reply.status !== 200 || typeof accessToken !== "string") {
    // Minecraft 服务端会校验 Azure 应用是否通过 AppID 审批，未审批的应用统一 403
    const raw = String((body as Json).errorMessage ?? (body as Json).error ?? reply.text ?? "");
    if (reply.status === 403 && /Invalid app registration/i.test(raw)) {
      throw new Error(mt("auth.ms.appNotApproved"));
    }
    throw new Error(failureText(mt("auth.ms.failLogin"), reply));
  }
  registerSecret(accessToken);
  const expiresIn = Number(body.expires_in) || 86_400;
  return { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
}

function requestProfile(accessToken: string): Promise<Reply> {
  return request(MC_PROFILE_URL, { method: "GET", headers: { authorization: "Bearer " + accessToken } });
}

/** 第 4 环：档案（id/name）。404 表示账号没有 Java 版游戏。 */
function expectProfile(reply: Reply): { id: string; name: string } {
  if (reply.status === 404) throw new Error(mt("auth.ms.notOwned"));
  const body: Json = reply.json ?? {};
  const id: unknown = body.id;
  const name: unknown = body.name;
  if (reply.status !== 200 || typeof id !== "string" || typeof name !== "string") {
    throw new Error(failureText(mt("auth.ms.failProfile"), reply));
  }
  return { id: id.toLowerCase(), name };
}

/** 进程内缓存 MC token：完整链路每次要打三次 Xbox 接口，没必要重复。 */
const sessions = new Map<string, CachedSession>();

async function mintSession(account: Account): Promise<CachedSession> {
  const fresh = await ensureFreshToken(account);
  const ms = fresh.microsoft;
  if (!ms) throw new Error(mt("auth.ms.notMicrosoftAccount"));
  const xbl = await authenticateXbl(ms.accessToken);
  const xsts = await authorizeXsts(xbl.token);
  const mc = await loginWithXbox(xbl.uhs, xsts.token);
  const session: CachedSession = { accessToken: mc.accessToken, expiresAt: mc.expiresAt };
  sessions.set(fresh.id, session);
  return session;
}

async function refreshTokens(account: Account): Promise<Account> {
  const ms = account.microsoft;
  if (!ms?.refreshToken) throw new Error(mt("auth.ms.noRefreshToken"));
  const clientId = await requireClientId();
  const reply = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: ms.refreshToken,
    scope: SCOPE,
  });
  const body: Json = reply.json ?? {};
  if (reply.status !== 200 || typeof body.access_token !== "string") {
    throw new Error(failureText(mt("auth.ms.failRefresh"), reply) + mt("auth.ms.signInAgainSuffix"));
  }
  const next = tokenSetFrom(body, ms.refreshToken);
  const updated = await updateMicrosoftTokens(account.id, {
    refreshToken: next.refreshToken,
    accessToken: next.accessToken,
    expiresAt: next.expiresAt,
  });
  // MC token 依赖旧 MS token 铸造，刷新后必须重新走链路
  sessions.delete(account.id);
  log.info("微软令牌已刷新：" + updated.name);
  return updated;
}

/** 到期前 60s 自动刷新；离线账号原样返回。 */
export async function ensureFreshToken(account: Account): Promise<Account> {
  const ms = account.microsoft;
  if (account.type !== "microsoft" || !ms) return account;
  if (ms.expiresAt - EXPIRY_SKEW_MS > Date.now()) return account;
  return refreshTokens(account);
}

/** 给启动游戏用：拿到可用的 Minecraft services access token。 */
export async function resolveMinecraftSession(
  account: Account,
): Promise<{ accessToken: string; uuid: string; name: string; expiresAt: number }> {
  if (account.type !== "microsoft" || !account.microsoft) throw new Error(mt("auth.ms.onlineOnlyMicrosoft"));
  const cached = sessions.get(account.id);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return { accessToken: cached.accessToken, uuid: account.uuid, name: account.name, expiresAt: cached.expiresAt };
  }
  const session = await mintSession(account);
  return { accessToken: session.accessToken, uuid: account.uuid, name: account.name, expiresAt: session.expiresAt };
}

/**
 * 给皮肤/披风接口用：令牌被提前吊销（401）时重建一次 Minecraft 会话。
 * 只复用既有的「刷新微软令牌 + 重走 XBL/XSTS 链路」，不改登录流程。
 */
export async function reauthenticateMinecraftSession(account: Account): Promise<{ accessToken: string; expiresAt: number }> {
  if (account.type !== "microsoft" || !account.microsoft) throw new Error(mt("auth.ms.onlineOnlyMicrosoft"));
  sessions.delete(account.id);
  const refreshed = await refreshTokens(account);
  const session = await mintSession(refreshed);
  return { accessToken: session.accessToken, expiresAt: session.expiresAt };
}

/** 读档案；401 说明 MC token 被提前吊销 → 刷新微软令牌后重走链路，只重试一次。 */
export async function getMinecraftProfile(account: Account): Promise<{ id: string; name: string }> {
  const session = await resolveMinecraftSession(account);
  const first = await requestProfile(session.accessToken);
  if (first.status !== 401) return expectProfile(first);
  sessions.delete(account.id);
  const refreshed = await refreshTokens(account);
  const retried = await mintSession(refreshed);
  return expectProfile(await requestProfile(retried.accessToken));
}

/** 第 0 环：申请设备码，把 code 与链接交给界面。 */
export async function beginDeviceCode(): Promise<DeviceCodeChallenge> {
  const clientId = await requireClientId();
  const reply = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE });
  const body: Json = reply.json ?? {};
  if (reply.status !== 200 || typeof body.device_code !== "string") {
    // 401/400 多半是 Azure 应用配置问题（未开公共客户端流 / client id 无效），必须给可操作提示
    throw new Error(failureText(mt("auth.ms.failDeviceCode"), reply));
  }
  log.info("已申请微软设备码，等待用户在浏览器中授权");
  return {
    deviceCode: body.device_code,
    userCode: typeof body.user_code === "string" ? body.user_code : "",
    verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : "https://microsoft.com/link",
    expiresIn: Number(body.expires_in) || 900,
    interval: Math.max(1, Number(body.interval) || 5),
  };
}

/** 轮询设备码：pending 让界面继续等，ok 已写入 accounts.json，error 给用户看。 */
export async function pollDeviceCode(deviceCode: string): Promise<MicrosoftLoginState> {
  const code = deviceCode.trim();
  if (!code) return { status: "error", message: mt("auth.ms.deviceCodeEmpty") };

  let clientId: string;
  try {
    clientId = await requireClientId();
  } catch (err) {
    return { status: "error", message: messageOf(err) };
  }

  try {
    const reply = await postForm(TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: code,
    });
    const body: Json = reply.json ?? {};

    if (reply.status === 200 && typeof body.access_token === "string") {
      const ms = tokenSetFrom(body);
      const account = await completeLogin(ms);
      log.info("微软账号登录成功：" + account.name);
      return { status: "ok", account };
    }

    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending" || error === "slow_down") return { status: "pending" };
    if (error === "expired_token") return { status: "error", message: mt("auth.ms.deviceCodeExpired") };
    if (error === "authorization_declined") return { status: "error", message: mt("auth.ms.authDeclined") };
    if (error === "bad_verification_code") return { status: "error", message: mt("auth.ms.deviceCodeInvalid") };
    if (error === "unauthorized_client" || error === "invalid_client") {
      return { status: "error", message: failureText(mt("auth.ms.failDeviceCode"), reply) };
    }
    return { status: "error", message: failureText(mt("auth.ms.failMicrosoftLogin"), reply) };
  } catch (err) {
    return { status: "error", message: messageOf(err) };
  }
}

async function completeLogin(ms: TokenSet): Promise<Account> {
  const xbl = await authenticateXbl(ms.accessToken);
  const xsts = await authorizeXsts(xbl.token);
  const mc = await loginWithXbox(xbl.uhs, xsts.token);
  const profile = expectProfile(await requestProfile(mc.accessToken));
  const account = await upsertMicrosoftAccount({
    name: profile.name,
    uuid: profile.id,
    refreshToken: ms.refreshToken,
    accessToken: ms.accessToken,
    expiresAt: ms.expiresAt,
    xuid: xsts.xuid || undefined,
  });
  sessions.set(account.id, { accessToken: mc.accessToken, expiresAt: mc.expiresAt });
  return account;
}
