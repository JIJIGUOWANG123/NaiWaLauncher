import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import type { Account } from "../../shared/types";
import type {
  MojangActionResult, MojangCapeEntry, MojangCapeRequest, MojangProfile, MojangSkinEntry, MojangSkinUploadRequest,
  MojangVariant,
} from "../../shared/ipc";
import { logger } from "../core/logger";
import { systemFetch } from "../core/netfetch";
import { getAccount } from "./accounts";
import { reauthenticateMinecraftSession, resolveMinecraftSession } from "./microsoft";
import { mt } from "../core/i18n";

const log = logger("mojang");

const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const TIMEOUT_MS = 20_000;
/** 上传要带整张图，链路更长，超时放宽（与 auth/skin.ts 一致）。 */
const UPLOAD_TIMEOUT_MS = 60_000;

const PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";
const SKINS_URL = PROFILE_URL + "/skins";
const CAPES_URL = PROFILE_URL + "/capes";
const ACTIVE_CAPE_URL = CAPES_URL + "/active";

/** PNG 文件头：8 字节签名，随后是 IHDR，宽/高在第 16..24 字节。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MIN_HEADER = 33;
/** Mojang 只接受这两种尺寸（1.8 之前的老格式仍可用）。 */
const SKIN_WIDTH = 64;
const SKIN_HEIGHTS = [64, 32];
/**
 * 皮肤文件大小上限。官方文档没有写死字节数；24 KB 是官方网页上传器的经验上限，
 * 而 64×64 的 PNG 通常只有 2–10 KB，所以这个阈值不会挡住正常皮肤。
 */
const MAX_SKIN_BYTES = 24 * 1024;
/** 错误分类：同一个状态码在不同接口上要说不同的话（例如 400 对披风是「未拥有」）。 */
type Ctx = "profile" | "skins" | "capes";

export interface Reply {
  status: number;
  json: Record<string, any> | null;
  text: string;
  contentType: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 手搓的 multipart 请求体：contentType 带 boundary，body 是可直接发送的字节。 */
export interface MultipartBody {
  contentType: string;
  boundary: string;
  body: Buffer;
}

/**
 * 构造 multipart/form-data 请求体（POST /minecraft/profile/skins 的推荐方式）。
 * 自己拼而不是用 FormData：请求体的每个 part 都能在自检里逐字节打印出来，
 * 也能保证 Content-Type（含 boundary）与 body 完全一致。
 */
export function buildSkinMultipart(bytes: Buffer, variant: MojangVariant, fileName = "skin.png"): MultipartBody {
  const boundary = "----NaiWaSkin" + randomBytes(12).toString("hex");
  const head: Buffer[] = [
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="variant"\r\n\r\n' + variant + '\r\n', "utf8"),
    Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName.replace(/["\r\n]/g, "_") +
        '"\r\nContent-Type: image/png\r\n\r\n',
      "utf8",
    ),
  ];
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
  return {
    contentType: "multipart/form-data; boundary=" + boundary,
    boundary,
    body: Buffer.concat([...head, bytes, tail]),
  };
}

/**
 * 上传前的本地校验：必须是 PNG，尺寸只能 64×64 / 64×32，且不超过大小上限。
 * 返回解析到的尺寸，便于日志与界面显示。不合规就抛可读原因（三语走主进程字典）。
 */
export function validateSkinBytes(bytes: Buffer, label: string): { width: number; height: number } {
  if (bytes.length === 0) throw new Error(mt("auth.mojang.emptyFile", { file: label }));
  if (bytes.length > MAX_SKIN_BYTES) {
    throw new Error(mt("auth.mojang.tooLarge", { file: label, actual: kb(bytes.length), max: kb(MAX_SKIN_BYTES) }));
  }
  if (bytes.length < PNG_MIN_HEADER || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(mt("auth.mojang.notPng", { file: label }));
  }
  if (bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error(mt("auth.mojang.notPng", { file: label }));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const ok = width === SKIN_WIDTH && SKIN_HEIGHTS.includes(height);
  if (!ok) throw new Error(mt("auth.mojang.badSize", { file: label, width, height }));
  return { width, height };
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/**
 * 官方边缘节点（Azure Front Door）对非 multipart 的 POST /skins 直接回一张 HTML
 * 「The request is blocked」403，与「账号没权限」的 403 完全是两回事，必须分开说。
 */
function isEdgeBlocked(reply: Reply): boolean {
  return /The request is blocked/i.test(reply.text) || /text\/html/i.test(reply.contentType);
}

function detailOf(reply: Reply): string {
  const body = reply.json ?? {};
  const message = str(body.errorMessage) || str(body.message) || str(body.error) || str(body.errorType);
  const raw = message || reply.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return raw ? " · " + raw.slice(0, 160) : "";
}

/**
 * HTTP 状态 → 人话（三语，走 core/i18n.ts 的 mt()）：
 * 401 令牌过期、403 无权/被边缘节点拦截、404 无档案、429 限流、400 按接口分开解释。
 */
export function describeStatus(status: number, reply: Reply, ctx: Ctx): string {
  if (status === 401) return mt("auth.mojang.expired");
  if (status === 403) return isEdgeBlocked(reply) ? mt("auth.mojang.blocked") : mt("auth.mojang.forbidden");
  if (status === 404) return mt("auth.mojang.noProfile");
  if (status === 429) return mt("auth.mojang.rateLimited");
  if (status === 400) {
    if (ctx === "capes") return mt("auth.mojang.capeNotOwned");
    if (ctx === "skins") return mt("auth.mojang.uploadRejected") + detailOf(reply);
  }
  return mt("auth.mojang.failed", { status, detail: detailOf(reply) });
}

/** 用给定的 access token 打一次官方接口（token 由调用方负责，便于离线自检直接注入）。 */
export async function mojangRequest(
  accessToken: string,
  method: string,
  url: string,
  init: { json?: unknown; multipart?: MultipartBody } = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json",
    authorization: "Bearer " + accessToken,
  };
  let body: BodyInit | undefined;
  if (init.multipart) {
    headers["content-type"] = init.multipart.contentType;
    // 复制到独立的 Uint8Array：Buffer 背后可能是共享内存，不是合法的 BodyInit
    const payload = new Uint8Array(init.multipart.body.byteLength);
    payload.set(init.multipart.body);
    body = payload;
  } else if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  try {
    // 走系统网络栈（系统代理 + Windows 证书库），与微软登录保持一致
    const res = await systemFetch(url, { method, headers, body, redirect: "follow", signal: controller.signal });
    const text = await res.text();
    let json: Record<string, any> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, any>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const reason = aborted ? mt("core.requestTimeout", { ms: timeoutMs }) : describe(err);
    throw new Error(reason + " · " + url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 账号级请求：先取（必要时刷新）Minecraft token；401 说明令牌被提前吊销，
 * 重建一次会话后重试一次——与 microsoft.getMinecraftProfile 的重试策略一致。
 */
async function callWithAccount(
  account: Account,
  method: string,
  url: string,
  init: { json?: unknown; multipart?: MultipartBody } = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Reply> {
  const session = await resolveMinecraftSession(account);
  const reply = await mojangRequest(session.accessToken, method, url, init, timeoutMs);
  if (reply.status !== 401) return reply;
  const fresh = await reauthenticateMinecraftSession(account);
  return mojangRequest(fresh.accessToken, method, url, init, timeoutMs);
}

/** 只有微软正版账号才有官方皮肤/披风接口；其它类型返回 null，界面据此显示「先去登录」。 */
async function premiumAccount(accountId: string): Promise<Account | null> {
  const id = (accountId ?? "").trim();
  if (!id) return null;
  const account = await getAccount(id);
  if (!account) throw new Error(mt("auth.mojang.noAccount", { id }));
  if (account.type !== "microsoft" || !account.microsoft) return null;
  return account;
}

function normalizeVariant(raw: unknown): MojangVariant {
  const value = str(raw).trim().toLowerCase();
  return value === "slim" || value === "alex" ? "slim" : "classic";
}

function parseSkins(raw: unknown): MojangSkinEntry[] {
  if (!Array.isArray(raw)) return [];
  const list: MojangSkinEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, any>;
    const url = str(src.url);
    if (!url) continue;
    list.push({ id: str(src.id), state: str(src.state).toUpperCase(), url, variant: normalizeVariant(src.variant) });
  }
  return list;
}

function parseCapes(raw: unknown): MojangCapeEntry[] {
  if (!Array.isArray(raw)) return [];
  const list: MojangCapeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, any>;
    const id = str(src.id);
    // 没有 id 的披风既不能显示成一项也不能「应用」，直接丢掉
    if (!id) continue;
    const alias = str(src.alias);
    list.push({ id, state: str(src.state).toUpperCase(), ...(alias ? { alias } : {}), url: str(src.url) });
  }
  return list;
}

/**
 * IPC skin:mojangProfile：官方档案（名字 + 皮肤 + 披风）。
 * 没有微软正版账号返回 null；其它失败落成 error 字段（界面提示，不弹框）。
 */
export async function getMojangProfile(accountId: string): Promise<MojangProfile | null> {
  const account = await premiumAccount(accountId);
  if (!account) return null;
  const empty: MojangProfile = { id: account.uuid, name: account.name, skins: [], capes: [] };
  let reply: Reply;
  try {
    reply = await callWithAccount(account, "GET", PROFILE_URL);
  } catch (err) {
    log.warn("读取官方档案失败：" + account.name + " · " + describe(err));
    return { ...empty, error: describe(err) };
  }
  if (reply.status !== 200 || !reply.json) {
    const error = describeStatus(reply.status, reply, "profile");
    log.warn("读取官方档案失败：" + account.name + " · HTTP " + reply.status);
    return { ...empty, error };
  }
  return {
    id: str(reply.json.id) || account.uuid,
    name: str(reply.json.name) || account.name,
    skins: parseSkins(reply.json.skins),
    capes: parseCapes(reply.json.capes),
  };
}

/** IPC skin:mojangCapes：该账号拥有的披风列表（GET /minecraft/profile/capes）。 */
export async function listMojangCapes(accountId: string): Promise<MojangCapeEntry[]> {
  const account = await premiumAccount(accountId);
  if (!account) return [];
  const reply = await callWithAccount(account, "GET", CAPES_URL);
  if (reply.status !== 200 || !reply.json) throw new Error(describeStatus(reply.status, reply, "capes"));
  return parseCapes(reply.json.capes);
}

/** 上传皮肤的方式二选一：本地文件（multipart，推荐）或图片直链（application/json）。 */
async function readUploadBytes(req: MojangSkinUploadRequest): Promise<{ multipart: MultipartBody; width: number; height: number }> {
  const path = (req.filePath ?? "").trim();
  if (!path) throw new Error(mt("auth.mojang.noFile"));
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(mt("auth.mojang.readFailed", { path, error: describe(err) }));
  }
  const size = validateSkinBytes(bytes, path);
  return { multipart: buildSkinMultipart(bytes, req.variant, "skin.png"), ...size };
}

/**
 * IPC skin:mojangUpload：把本地 PNG（multipart）或图片直链（JSON）设成官方皮肤。
 * 失败一律落成 ok=false + 可读原因，界面只 toast。
 * 0.4.3 起界面已不提供（正版皮肤只读，只能去微软官网改），这里仅保留接口不动 IPC 契约。
 */
export async function uploadMojangSkin(req: MojangSkinUploadRequest): Promise<MojangActionResult> {
  let account: Account | null;
  try {
    account = await premiumAccount(req.accountId);
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
  if (!account) return { ok: false, error: mt("auth.mojang.notPremium") };

  const url = (req.url ?? "").trim();
  const variant: MojangVariant = normalizeVariant(req.variant);
  try {
    let reply: Reply;
    if (url) {
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: mt("auth.mojang.badUrl", { url }) };
      reply = await callWithAccount(account, "POST", SKINS_URL, { json: { url, variant } }, UPLOAD_TIMEOUT_MS);
    } else {
      const { multipart, width, height } = await readUploadBytes(req);
      reply = await callWithAccount(account, "POST", SKINS_URL, { multipart }, UPLOAD_TIMEOUT_MS);
      log.info("上传官方皮肤：" + account.name + " · " + variant + " · " + width + "×" + height);
    }
    if (reply.status !== 200 && reply.status !== 204) {
      const error = describeStatus(reply.status, reply, "skins");
      log.warn("上传官方皮肤失败：" + account.name + " · HTTP " + reply.status);
      return { ok: false, error };
    }
    log.info("官方皮肤已更新：" + account.name + " · " + variant + (url ? " · URL" : " · 本地 PNG"));
    return { ok: true };
  } catch (err) {
    const error = describe(err);
    log.warn("上传官方皮肤失败：" + account.name + " · " + error);
    return { ok: false, error };
  }
}

/**
 * IPC skin:mojangSetCape：切换/移除当前披风。（0.4.3 界面仍保留「应用 / 移除披风」按钮，接口照常使用。）
 * 官方接口是 PUT /minecraft/profile/capes/active，body {"capeId": "<id>"}；
 * 移除当前披风用同一个接口传 {"capeId": null}（详见回报里的说明与未验证项）。
 */
export async function setMojangCape(req: MojangCapeRequest): Promise<MojangActionResult> {
  let account: Account | null;
  try {
    account = await premiumAccount(req.accountId);
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
  if (!account) return { ok: false, error: mt("auth.mojang.notPremium") };

  const capeId = req.capeId === null || req.capeId === undefined ? null : String(req.capeId).trim();
  if (capeId !== null && !capeId) return { ok: false, error: mt("auth.mojang.capeMissing") };
  try {
    const reply = await callWithAccount(account, "PUT", ACTIVE_CAPE_URL, { json: { capeId } });
    if (reply.status !== 200 && reply.status !== 204) {
      const error = describeStatus(reply.status, reply, "capes");
      log.warn("切换官方披风失败：" + account.name + " · HTTP " + reply.status);
      return { ok: false, error };
    }
    log.info((capeId ? "已应用官方披风：" : "已移除官方披风：") + account.name);
    return { ok: true };
  } catch (err) {
    const error = describe(err);
    log.warn("切换官方披风失败：" + account.name + " · " + error);
    return { ok: false, error };
  }
}
