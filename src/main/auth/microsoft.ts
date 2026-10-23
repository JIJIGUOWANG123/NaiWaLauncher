import type { Account, DeviceCodeChallenge, MicrosoftLoginState } from "../../shared/types";
import { logger, registerSecret } from "../core/logger";
import { systemFetch } from "../core/netfetch";
import { getSettings, loadSettings } from "../core/settings";
import { updateMicrosoftTokens, upsertMicrosoftAccount } from "./accounts";

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
const MISSING_CLIENT_ID = "请先在设置里填写 Azure 应用 client id（XboxLive.signin 权限）";

type Json = Record<string, any>;

interface Reply {
  status: number;
  json: Json | null;
  text: string;
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
    return "TLS 证书校验失败（code=" + code + "）——常见于公司/校园网的 HTTPS 拦截或杀毒软件的证书替换；请关闭拦截或把其根证书加入系统信任";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return "域名解析失败（code=" + code + "）——请检查 DNS 或稍后重试";
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code)) {
    return "连接被中断或超时（code=" + code + "）——网络抖动或代理不稳定，可直接重试";
  }
  return code ? "网络错误（code=" + code + "）" : "";
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
    const reason = aborted ? "请求超时（" + TIMEOUT_MS + "ms）" : [messageOf(err), networkReason(err)].filter(Boolean).join("；");
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

function postXbl(url: string, body: unknown): Promise<Reply> {
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

/** 把 OAuth / Xbox / Minecraft 三类错误体统一压成一句中文可读的错误。 */
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

/** AADSTS 错误码 → 用户能自己动手解决的中文提示（码本身必须出现在文案里，便于对照微软文档）。 */
const AADSTS_HINTS: Record<string, string> = {
  AADSTS70002:
    "Azure 应用未开启「允许公共客户端流」：请到 Azure 门户 → 应用注册 → 认证 → 设为「是」（AADSTS70002）",
  AADSTS700016: "client id 无效或应用未注册：请检查设置里的 Azure 应用 client id（AADSTS700016）",
  AADSTS700038: "client id 无效或应用未注册：请检查设置里的 Azure 应用 client id（AADSTS700038）",
  AADSTS7000014: "设备码无效或已过期，请重新开始登录（AADSTS7000014）",
  AADSTS7000012: "刷新令牌与当前 client id / 租户不匹配，请用这个 client id 重新登录（AADSTS7000012）",
  AADSTS54005: "设备码已被使用，请重新开始登录（AADSTS54005）",
};

/**
 * 拼错误文案：中文可操作提示在前，原始 OAuth 描述（含 AADSTS 码）在后。
 * 只要响应里带 AADSTS 码，成文里一定保留它。
 */
function failureText(prefix: string, reply: Reply): string {
  const detail = describeFailure(reply);
  const code = aadstsCode(detail) || aadstsCode(reply.text);
  const hint = AADSTS_HINTS[code];
  if (hint) return prefix + hint + " · " + detail;
  if (code) return prefix + detail;
  return prefix + "HTTP " + reply.status + (detail ? " · " + detail : "");
}

const XSTS_MESSAGES: Record<number, string> = {
  2148916233: "该微软账号还没有 Xbox 账号，请先到 xbox.com 创建",
  2148916238: "该账号未成年，需要家长把它加入 Microsoft 家庭组后才能登录",
  2148916235: "该账号所在地区不支持 Xbox Live",
};

/** XSTS 的 XErr 翻译成人话；未知码保留原始码便于排查。 */
export function xstsErrorMessage(xerr: number, detail?: string): string {
  const known = XSTS_MESSAGES[xerr];
  if (known) return known;
  const suffix = detail ? "（" + detail.slice(0, 120) + "）" : "";
  return "Xbox 授权失败：XErr " + xerr + suffix;
}

function xboxFailure(reply: Reply): string {
  const body: Json = reply.json ?? {};
  const xerr = Number(body.XErr ?? 0);
  if (Number.isFinite(xerr) && xerr > 0) {
    const detail = typeof body.Message === "string" && body.Message ? body.Message : undefined;
    return xstsErrorMessage(xerr, detail);
  }
  // Xbox 对无效 RPS 票据只回一个空体 401，翻译成用户能照做的动作
  if (reply.status === 401) return "微软凭证已失效，请重新登录该账号";
  return failureText("Xbox 认证失败：", reply);
}

async function requireClientId(): Promise<string> {
  // 缓存可能是默认值（未加载过设置），这里强制读盘，避免误报“没填 client id”
  await loadSettings();
  const clientId = getSettings().microsoftClientId.trim();
  if (!clientId) throw new Error(MISSING_CLIENT_ID);
  return clientId;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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
      throw new Error(
        "该 Azure 应用还没有获得 Minecraft 服务授权：请用同一 client id 向 Mojang 提交 AppID 审批" +
          "（https://help.minecraft.net/hc/en-us/articles/16254801392141 ），审批通过前微软账号无法进入正版服务器；" +
          "离线账号不受影响（403 Invalid app registration）",
      );
    }
    throw new Error(failureText("Minecraft 登录失败：", reply));
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
  if (reply.status === 404) throw new Error("该账号没有 Minecraft：Java 版（未购买游戏）");
  const body: Json = reply.json ?? {};
  const id: unknown = body.id;
  const name: unknown = body.name;
  if (reply.status !== 200 || typeof id !== "string" || typeof name !== "string") {
    throw new Error(failureText("读取 Minecraft 档案失败：", reply));
  }
  return { id: id.toLowerCase(), name };
}

interface CachedSession {
  accessToken: string;
  expiresAt: number;
}

/** 进程内缓存 MC token：完整链路每次要打三次 Xbox 接口，没必要重复。 */
const sessions = new Map<string, CachedSession>();

async function mintSession(account: Account): Promise<CachedSession> {
  const fresh = await ensureFreshToken(account);
  const ms = fresh.microsoft;
  if (!ms) throw new Error("该账号不是微软账号，无法获取在线会话");
  const xbl = await authenticateXbl(ms.accessToken);
  const xsts = await authorizeXsts(xbl.token);
  const mc = await loginWithXbox(xbl.uhs, xsts.token);
  const session: CachedSession = { accessToken: mc.accessToken, expiresAt: mc.expiresAt };
  sessions.set(fresh.id, session);
  return session;
}

async function refreshTokens(account: Account): Promise<Account> {
  const ms = account.microsoft;
  if (!ms?.refreshToken) throw new Error("该账号没有 refresh token，请重新登录微软账号");
  const clientId = await requireClientId();
  const reply = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: ms.refreshToken,
    scope: SCOPE,
  });
  const body: Json = reply.json ?? {};
  if (reply.status !== 200 || typeof body.access_token !== "string") {
    throw new Error(failureText("微软令牌刷新失败：", reply) + "；请重新登录该账号");
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
  if (account.type !== "microsoft" || !account.microsoft) throw new Error("只有微软账号才有在线会话");
  const cached = sessions.get(account.id);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return { accessToken: cached.accessToken, uuid: account.uuid, name: account.name, expiresAt: cached.expiresAt };
  }
  const session = await mintSession(account);
  return { accessToken: session.accessToken, uuid: account.uuid, name: account.name, expiresAt: session.expiresAt };
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
    throw new Error(failureText("申请设备码失败：", reply));
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
  if (!code) return { status: "error", message: "设备码为空，请重新开始登录" };

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
    if (error === "expired_token") return { status: "error", message: "设备码已过期，请重新开始登录" };
    if (error === "authorization_declined") return { status: "error", message: "你在浏览器里取消了授权" };
    if (error === "bad_verification_code") return { status: "error", message: "设备码无效，请重新开始登录" };
    if (error === "unauthorized_client" || error === "invalid_client") {
      return { status: "error", message: failureText("申请设备码失败：", reply) };
    }
    return { status: "error", message: failureText("微软登录失败：", reply) };
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