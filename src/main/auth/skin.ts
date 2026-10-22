import { readFile } from "node:fs/promises";

import { dialog } from "electron";

import type { Account, SkinInfo } from "../../shared/types";
import { logger } from "../core/logger";
import { getAccount } from "./accounts";
import { resolveMinecraftSession } from "./microsoft";

const log = logger("skin");

const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const REQUEST_TIMEOUT_MS = 20_000;
/** 上传要带整张图，链路更长，超时放宽。 */
const UPLOAD_TIMEOUT_MS = 60_000;
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";
const MC_SKIN_URL = MC_PROFILE_URL + "/skins";
const MC_ACTIVE_SKIN_URL = MC_SKIN_URL + "/active";

const NO_SKIN_SERVICE = "离线账号没有皮肤服务";
const TOKEN_EXPIRED = "登录已过期，请重新登录该账号";
const APP_UNAUTHORIZED = "该微软应用尚未获得 Minecraft 服务授权，暂时无法编辑皮肤";
const BAD_IMAGE = "皮肤图片必须是 64×64（或 64×32）的 PNG";
const NO_TEXTURE_API = "该皮肤站没有提供材质上传接口（authlib-injector 材质上传），请到皮肤站网页上传";
const NO_RESET_API = "该皮肤站没有提供材质上传接口（authlib-injector 材质上传），请到皮肤站网页恢复默认皮肤";

export type SkinModel = "classic" | "slim";

/** PNG 文件头：8 字节签名后紧跟 IHDR，宽度/高度在第 16..24 字节。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MIN_HEADER = 33;

type Json = Record<string, any>;

interface Reply {
  status: number;
  json: Json | null;
  text: string;
  contentType: string;
}

/** 皮肤信息里「能拿到的部分」，来源接口不同，缺哪个字段就是没有。 */
interface SkinDetail {
  skinUrl?: string;
  capeUrl?: string;
  model?: SkinModel;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 直接用 fetch 而不是 core/http 的 fetchJson：这里的失败要区分 401/403（令牌失效）
 * 与其它错误码，fetchJson 会丢掉响应体，翻不出服务端的 errorMessage。
 */
async function request(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      // FormData 的 content-type（含 boundary）必须由 fetch 自己生成，这里不能覆盖
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let json: Json | null = null;
    try {
      json = text ? (JSON.parse(text) as Json) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "请求超时（" + timeoutMs + "ms）" : describe(err);
    throw new Error(reason + " · " + url);
  } finally {
    clearTimeout(timer);
  }
}

/** 把「非 2xx + 错误体」压成一句可读中文，原始描述保留便于排查。 */
function failureText(prefix: string, reply: Reply): string {
  const body = reply.json ?? {};
  const message = str(body.errorMessage) || str(body.message) || str(body.error) || reply.text.slice(0, 200).trim();
  return prefix + "HTTP " + reply.status + (message ? " · " + message : "");
}

/** 材质接口相对 Yggdrasil API 根：{apiUrl}/api/user/profile/{uuid}/skin。 */
function profileSkinUrl(apiUrl: string, uuid: string): string {
  return apiUrl.replace(/\/+$/, "") + "/api/user/profile/" + encodeURIComponent(uuid) + "/skin";
}

function sessionServerUrl(apiUrl: string, uuid: string): string {
  return apiUrl.replace(/\/+$/, "") + "/sessionserver/session/minecraft/profile/" + encodeURIComponent(uuid) + "?unsigned=false";
}

function normalizeModel(raw: unknown): SkinModel | undefined {
  const value = str(raw).trim().toLowerCase();
  if (value === "slim" || value === "alex") return "slim";
  if (value === "classic" || value === "steve" || value === "wide") return "classic";
  return undefined;
}

function variantOf(model: unknown): "slim" | "classic" {
  return normalizeModel(model) === "slim" ? "slim" : "classic";
}

/** 皮肤站专有接口：能直接拿到当前上传的皮肤与 model，比 session server 快一步。 */
async function readSiteSkin(apiUrl: string, uuid: string): Promise<SkinDetail | null> {
  const reply = await request(profileSkinUrl(apiUrl, uuid), { method: "GET" }).catch(() => null);
  // 不实现这个接口的站点就是 404/HTML，交给 session server 兜底
  if (!reply || reply.status !== 200 || !reply.json) return null;
  const body = reply.json;
  const textures = body.textures && typeof body.textures === "object" ? (body.textures as Json) : {};
  const nestedSkin = textures.SKIN && typeof textures.SKIN === "object" ? (textures.SKIN as Json) : {};
  const skinUrl = str(body.url) || str(body.skinUrl) || str(body.skin) || str(nestedSkin.url);
  if (!skinUrl) return null;
  const model = normalizeModel(body.model ?? body.type ?? body.variant ?? nestedSkin.metadata?.model);
  return { skinUrl, model: model ?? "classic" };
}

/** 标准 Yggdrasil：sessionserver 档案里的 textures 属性（base64）。 */
async function readSessionServerSkin(apiUrl: string, uuid: string): Promise<SkinDetail> {
  const reply = await request(sessionServerUrl(apiUrl, uuid), { method: "GET" });
  // 204 = 该角色没有皮肤档案（authlib-injector 的约定）
  if (reply.status === 204) return {};
  if (reply.status !== 200 || !reply.json) throw new Error(failureText("读取皮肤信息失败：", reply));

  const properties = Array.isArray(reply.json.properties) ? (reply.json.properties as Json[]) : [];
  const texturesProperty = properties.find((item) => item && item.name === "textures");
  const value = texturesProperty ? str(texturesProperty.value) : "";
  if (!value) return {};

  let decoded: Json;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Json;
  } catch {
    throw new Error("皮肤站返回的 textures 数据无法解析");
  }
  const textures = decoded.textures && typeof decoded.textures === "object" ? (decoded.textures as Json) : {};
  const skin = textures.SKIN && typeof textures.SKIN === "object" ? (textures.SKIN as Json) : {};
  const cape = textures.CAPE && typeof textures.CAPE === "object" ? (textures.CAPE as Json) : {};
  const skinUrl = str(skin.url);
  const capeUrl = str(cape.url);
  // textures 不带 metadata.model 就是 classic（Mojang 只在 slim 时写 model）
  const model = normalizeModel(skin.metadata?.model);
  return {
    ...(skinUrl ? { skinUrl } : {}),
    ...(capeUrl ? { capeUrl } : {}),
    ...(skinUrl ? { model: model ?? "classic" } : {}),
  };
}

/**
 * login_with_xbox 的 403 = Mojang 未授权该 Azure 应用。响应体文案不稳定（有/没有
 * Invalid app registration），所以带上 HTTP 403 一起认；其它环节的 Xbox 失败是 401/400 + XErr。
 */
function isUnauthorizedApp(message: string): boolean {
  return /Invalid app registration/i.test(message) || /HTTP 403|403 Forbidden/i.test(message);
}

/** 把 accessToken 换成 Minecraft services 令牌；403（Mojang 未授权该 Azure 应用）单独识别。 */
async function minecraftToken(account: Account): Promise<string> {
  const session = await resolveMinecraftSession(account);
  return session.accessToken;
}

async function yggdrasilSkin(account: Account): Promise<SkinInfo> {
  const ygg = account.yggdrasil;
  if (!ygg?.apiUrl) return { source: "yggdrasil", canUpload: false, error: "该账号缺少第三方站点地址，请重新登录" };
  try {
    const site = await readSiteSkin(ygg.apiUrl, account.uuid);
    const detail = site ?? (await readSessionServerSkin(ygg.apiUrl, account.uuid));
    return { source: "yggdrasil", canUpload: true, ...detail };
  } catch (err) {
    log.warn("读取第三方皮肤失败：" + account.name + " · " + describe(err));
    return { source: "yggdrasil", canUpload: true, error: describe(err) };
  }
}

async function mojangSkin(account: Account): Promise<SkinInfo> {
  let accessToken: string;
  try {
    accessToken = await minecraftToken(account);
  } catch (err) {
    const message = describe(err);
    if (isUnauthorizedApp(message)) return { source: "mojang", canUpload: false, error: APP_UNAUTHORIZED };
    log.warn("读取微软皮肤失败（会话铸造）：" + account.name + " · " + message);
    return { source: "mojang", canUpload: true, error: message };
  }

  const reply = await request(MC_PROFILE_URL, { method: "GET", headers: { authorization: "Bearer " + accessToken } }).catch(
    (err: unknown) => ({ status: 0, json: null, text: describe(err), contentType: "" }) as Reply,
  );
  if (reply.status === 0) {
    return { source: "mojang", canUpload: true, error: reply.text };
  }
  if (reply.status === 401 || reply.status === 403) {
    return { source: "mojang", canUpload: false, error: TOKEN_EXPIRED };
  }
  if (reply.status !== 200 || !reply.json) {
    return { source: "mojang", canUpload: true, error: failureText("读取皮肤信息失败：", reply) };
  }

  const skins = Array.isArray(reply.json.skins) ? (reply.json.skins as Json[]) : [];
  const capes = Array.isArray(reply.json.capes) ? (reply.json.capes as Json[]) : [];
  const active = skins.find((item) => str(item.state).toUpperCase() === "ACTIVE") ?? skins[0];
  const cape = capes.find((item) => str(item.state).toUpperCase() === "ACTIVE") ?? capes[0];
  const skinUrl = active ? str(active.url) : "";
  const capeUrl = cape ? str(cape.url) : "";
  const model = active ? normalizeModel(active.variant) : undefined;
  return {
    source: "mojang",
    canUpload: true,
    ...(skinUrl ? { skinUrl } : {}),
    ...(capeUrl ? { capeUrl } : {}),
    ...(model ? { model } : {}),
  };
}

/** IPC skins:get：读该账号当前的皮肤/披风。任何失败都落成可展示的 error，不抛给渲染进程。 */
export async function getSkin(accountId: string): Promise<SkinInfo> {
  const account = await getAccount(accountId);
  if (!account) return { source: "none", canUpload: false, error: "账号不存在：" + accountId };
  if (account.type === "offline") return { source: "none", canUpload: false, error: NO_SKIN_SERVICE };
  if (account.type === "yggdrasil") return yggdrasilSkin(account);
  return mojangSkin(account);
}

/** 读 IHDR 校验：必须是 64×64 或 64×32 的 PNG（1.8 之前的老格式仍可用）。 */
async function readSkinPng(filePath: string): Promise<Buffer> {
  const path = (filePath ?? "").trim();
  if (!path) throw new Error("请先选择皮肤图片");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error("无法读取皮肤文件：" + path + " · " + describe(err));
  }
  if (bytes.length < PNG_MIN_HEADER || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(BAD_IMAGE);
  if (bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error(BAD_IMAGE);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const supported = width === 64 && (height === 64 || height === 32);
  if (!supported) throw new Error(BAD_IMAGE);
  return bytes;
}

function skinBlob(bytes: Buffer): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

/** 上传结果统一判定：401/403 是令牌问题，404 是站点没实现这个接口。 */
function acceptSkinWrite(reply: Reply, missingMessage: string): void {
  if (reply.status === 401 || reply.status === 403) throw new Error(TOKEN_EXPIRED);
  if (reply.status === 404) throw new Error(missingMessage);
  if (reply.status !== 200 && reply.status !== 204) throw new Error(failureText("上传皮肤失败：", reply));
}

function yggForm(bytes: Buffer, model: "slim" | "classic"): FormData {
  const form = new FormData();
  form.append("file", skinBlob(bytes), "skin.png");
  form.append("model", model);
  return form;
}

async function uploadYggdrasilSkin(account: Account, bytes: Buffer, model: "slim" | "classic"): Promise<void> {
  const ygg = account.yggdrasil;
  if (!ygg?.apiUrl || !ygg.accessToken) throw new Error(TOKEN_EXPIRED);
  const url = profileSkinUrl(ygg.apiUrl, account.uuid);
  const headers = { authorization: "Bearer " + ygg.accessToken };
  // authlib-injector 的材质上传是 PUT + model 查询参数；model 同时作为表单字段发一份，兼容只读表单的实现
  const put = await request(url + "?model=" + model, { method: "PUT", headers, body: yggForm(bytes, model) }, UPLOAD_TIMEOUT_MS);
  if (put.status !== 404 && put.status !== 405) {
    acceptSkinWrite(put, NO_TEXTURE_API);
    return;
  }
  const post = await request(url, { method: "POST", headers, body: yggForm(bytes, model) }, UPLOAD_TIMEOUT_MS);
  acceptSkinWrite(post, NO_TEXTURE_API);
}

async function uploadMojangSkin(account: Account, bytes: Buffer, model: "slim" | "classic"): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await minecraftToken(account);
  } catch (err) {
    const message = describe(err);
    throw new Error(isUnauthorizedApp(message) ? APP_UNAUTHORIZED : message);
  }
  const form = new FormData();
  form.append("variant", model);
  form.append("file", skinBlob(bytes), "skin.png");
  const reply = await request(
    MC_SKIN_URL,
    { method: "POST", headers: { authorization: "Bearer " + accessToken }, body: form },
    UPLOAD_TIMEOUT_MS,
  );
  if (reply.status === 401 || reply.status === 403) throw new Error(TOKEN_EXPIRED);
  if (reply.status !== 200 && reply.status !== 204) throw new Error(failureText("上传皮肤失败：", reply));
}

/** IPC skins:upload：校验图片后按账号类型上传（失败抛可读文案，由 IPC 层转给界面）。 */
export async function uploadSkin(accountId: string, filePath: string, model: SkinModel): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("账号不存在：" + accountId);
  if (account.type === "offline") throw new Error(NO_SKIN_SERVICE);
  const bytes = await readSkinPng(filePath);
  const variant = variantOf(model);
  if (account.type === "yggdrasil") await uploadYggdrasilSkin(account, bytes, variant);
  else await uploadMojangSkin(account, bytes, variant);
  log.info("皮肤已上传：" + account.name + " · " + variant + " · " + bytes.length + " 字节");
}

async function resetYggdrasilSkin(account: Account): Promise<void> {
  const ygg = account.yggdrasil;
  if (!ygg?.apiUrl || !ygg.accessToken) throw new Error(TOKEN_EXPIRED);
  const reply = await request(profileSkinUrl(ygg.apiUrl, account.uuid), {
    method: "DELETE",
    headers: { authorization: "Bearer " + ygg.accessToken },
  });
  if (reply.status === 401 || reply.status === 403) throw new Error(TOKEN_EXPIRED);
  // 404 = 站点没有这个接口（规范里清除材质成功是 204），不能当成「已经恢复」
  if (reply.status === 404) throw new Error(NO_RESET_API);
  if (reply.status !== 200 && reply.status !== 204) throw new Error(failureText("恢复默认皮肤失败：", reply));
}

async function resetMojangSkin(account: Account): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await minecraftToken(account);
  } catch (err) {
    const message = describe(err);
    throw new Error(isUnauthorizedApp(message) ? APP_UNAUTHORIZED : message);
  }
  const reply = await request(MC_ACTIVE_SKIN_URL, { method: "DELETE", headers: { authorization: "Bearer " + accessToken } });
  if (reply.status === 401 || reply.status === 403) throw new Error(TOKEN_EXPIRED);
  if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) {
    throw new Error(failureText("恢复默认皮肤失败：", reply));
  }
}

/** IPC skins:reset：删掉当前皮肤，回到默认（Steve/Alex）。 */
export async function resetSkin(accountId: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("账号不存在：" + accountId);
  if (account.type === "offline") throw new Error(NO_SKIN_SERVICE);
  if (account.type === "yggdrasil") await resetYggdrasilSkin(account);
  else await resetMojangSkin(account);
  log.info("已恢复默认皮肤：" + account.name);
}

/** IPC skins:pickFile：让用户选一张 PNG，取消返回 null。 */
export async function pickSkinFile(): Promise<string | null> {
  const picked = await dialog.showOpenDialog({
    title: "选择皮肤图片",
    properties: ["openFile"],
    filters: [{ name: "皮肤图片", extensions: ["png"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return picked.filePaths[0];
}
