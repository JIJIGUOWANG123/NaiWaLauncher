import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { dialog } from "electron";

import type { Account, SkinInfo, SkinProfile, WardrobeSkin } from "../../shared/types";
import { logger, registerSecret } from "../core/logger";
import { getPaths } from "../core/paths";
import { getAccount, updateYggdrasilProfile } from "./accounts";
import { resolveMinecraftSession } from "./microsoft";
import { mt } from "../core/i18n";

const log = logger("skin");

const USER_AGENT = "NaiWaLauncher/0.1 (naiwa)";
const REQUEST_TIMEOUT_MS = 20_000;
/** 上传要带整张图，链路更长，超时放宽。 */
const UPLOAD_TIMEOUT_MS = 60_000;
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";
const MC_SKIN_URL = MC_PROFILE_URL + "/skins";
const MC_ACTIVE_SKIN_URL = MC_SKIN_URL + "/active";

function noSkinService(): string {
  return mt("auth.skin.noService");
}
function tokenExpired(): string {
  return mt("auth.skin.tokenExpired");
}
function appUnauthorized(): string {
  return mt("auth.skin.appUnauthorized");
}
function badImage(): string {
  return mt("auth.skin.badImage");
}
function noTextureApi(): string {
  return mt("auth.skin.noTextureApi");
}
function noResetApi(): string {
  return mt("auth.skin.noResetApi");
}
function noSwitchableProfile(): string {
  return mt("auth.skin.noSwitchableProfile");
}

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
    const reason = err instanceof Error && err.name === "AbortError" ? mt("core.requestTimeout", { ms: timeoutMs }) : describe(err);
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
  if (reply.status !== 200 || !reply.json) throw new Error(failureText(mt("auth.skin.failRead"), reply));

  const properties = Array.isArray(reply.json.properties) ? (reply.json.properties as Json[]) : [];
  const texturesProperty = properties.find((item) => item && item.name === "textures");
  const value = texturesProperty ? str(texturesProperty.value) : "";
  if (!value) return {};

  let decoded: Json;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Json;
  } catch {
    throw new Error(mt("auth.skin.texturesUnparsable"));
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
  if (!ygg?.apiUrl) return { source: "yggdrasil", canUpload: false, error: mt("auth.skin.missingApiUrl") };
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
    if (isUnauthorizedApp(message)) return { source: "mojang", canUpload: false, error: appUnauthorized() };
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
    return { source: "mojang", canUpload: false, error: tokenExpired() };
  }
  if (reply.status !== 200 || !reply.json) {
    return { source: "mojang", canUpload: true, error: failureText(mt("auth.skin.failRead"), reply) };
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
  if (!account) return { source: "none", canUpload: false, error: mt("auth.account.notFound", { id: accountId }) };
  if (account.type === "offline") return { source: "none", canUpload: false, error: noSkinService() };
  if (account.type === "yggdrasil") return yggdrasilSkin(account);
  return mojangSkin(account);
}

/** 读 IHDR 校验：必须是 64×64 或 64×32 的 PNG（1.8 之前的老格式仍可用）。 */
async function readSkinPng(filePath: string): Promise<Buffer> {
  const path = (filePath ?? "").trim();
  if (!path) throw new Error(mt("auth.skin.pickFileFirst"));
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(mt("auth.skin.readFailed", { path, error: describe(err) }));
  }
  if (bytes.length < PNG_MIN_HEADER || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(badImage());
  if (bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error(badImage());
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const supported = width === 64 && (height === 64 || height === 32);
  if (!supported) throw new Error(badImage());
  return bytes;
}

function skinBlob(bytes: Buffer): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

/** 上传结果统一判定：401/403 是令牌问题，404 是站点没实现这个接口。 */
function acceptSkinWrite(reply: Reply, missingMessage: string): void {
  if (reply.status === 401 || reply.status === 403) throw new Error(tokenExpired());
  if (reply.status === 404) throw new Error(missingMessage);
  if (reply.status !== 200 && reply.status !== 204) throw new Error(failureText(mt("auth.skin.failUpload"), reply));
}

function yggForm(bytes: Buffer, model: "slim" | "classic"): FormData {
  const form = new FormData();
  form.append("file", skinBlob(bytes), "skin.png");
  form.append("model", model);
  return form;
}

async function uploadYggdrasilSkin(account: Account, bytes: Buffer, model: "slim" | "classic"): Promise<void> {
  const ygg = account.yggdrasil;
  if (!ygg?.apiUrl || !ygg.accessToken) throw new Error(tokenExpired());
  const url = profileSkinUrl(ygg.apiUrl, account.uuid);
  const headers = { authorization: "Bearer " + ygg.accessToken };
  // authlib-injector 的材质上传是 PUT + model 查询参数；model 同时作为表单字段发一份，兼容只读表单的实现
  const put = await request(url + "?model=" + model, { method: "PUT", headers, body: yggForm(bytes, model) }, UPLOAD_TIMEOUT_MS);
  if (put.status !== 404 && put.status !== 405) {
    acceptSkinWrite(put, noTextureApi());
    return;
  }
  const post = await request(url, { method: "POST", headers, body: yggForm(bytes, model) }, UPLOAD_TIMEOUT_MS);
  acceptSkinWrite(post, noTextureApi());
}

async function uploadMojangSkin(account: Account, bytes: Buffer, model: "slim" | "classic"): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await minecraftToken(account);
  } catch (err) {
    const message = describe(err);
    throw new Error(isUnauthorizedApp(message) ? appUnauthorized() : message);
  }
  const form = new FormData();
  form.append("variant", model);
  form.append("file", skinBlob(bytes), "skin.png");
  const reply = await request(
    MC_SKIN_URL,
    { method: "POST", headers: { authorization: "Bearer " + accessToken }, body: form },
    UPLOAD_TIMEOUT_MS,
  );
  if (reply.status === 401 || reply.status === 403) throw new Error(tokenExpired());
  if (reply.status !== 200 && reply.status !== 204) throw new Error(failureText(mt("auth.skin.failUpload"), reply));
}

/** IPC skins:upload：校验图片后按账号类型上传（失败抛可读文案，由 IPC 层转给界面）。 */
export async function uploadSkin(accountId: string, filePath: string, model: SkinModel): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(mt("auth.account.notFound", { id: accountId }));
  if (account.type === "offline") throw new Error(noSkinService());
  const bytes = await readSkinPng(filePath);
  const variant = variantOf(model);
  if (account.type === "yggdrasil") await uploadYggdrasilSkin(account, bytes, variant);
  else await uploadMojangSkin(account, bytes, variant);
  log.info("皮肤已上传：" + account.name + " · " + variant + " · " + bytes.length + " 字节");
}

async function resetYggdrasilSkin(account: Account): Promise<void> {
  const ygg = account.yggdrasil;
  if (!ygg?.apiUrl || !ygg.accessToken) throw new Error(tokenExpired());
  const reply = await request(profileSkinUrl(ygg.apiUrl, account.uuid), {
    method: "DELETE",
    headers: { authorization: "Bearer " + ygg.accessToken },
  });
  if (reply.status === 401 || reply.status === 403) throw new Error(tokenExpired());
  // 404 = 站点没有这个接口（规范里清除材质成功是 204），不能当成「已经恢复」
  if (reply.status === 404) throw new Error(noResetApi());
  if (reply.status !== 200 && reply.status !== 204) throw new Error(failureText(mt("auth.skin.failReset"), reply));
}

async function resetMojangSkin(account: Account): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await minecraftToken(account);
  } catch (err) {
    const message = describe(err);
    throw new Error(isUnauthorizedApp(message) ? appUnauthorized() : message);
  }
  const reply = await request(MC_ACTIVE_SKIN_URL, { method: "DELETE", headers: { authorization: "Bearer " + accessToken } });
  if (reply.status === 401 || reply.status === 403) throw new Error(tokenExpired());
  if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) {
    throw new Error(failureText(mt("auth.skin.failReset"), reply));
  }
}

/** IPC skins:reset：删掉当前皮肤，回到默认（Steve/Alex）。 */
export async function resetSkin(accountId: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(mt("auth.account.notFound", { id: accountId }));
  if (account.type === "offline") throw new Error(noSkinService());
  if (account.type === "yggdrasil") await resetYggdrasilSkin(account);
  else await resetMojangSkin(account);
  log.info("已恢复默认皮肤：" + account.name);
}

/** IPC skins:pickFile：让用户选一张 PNG，取消返回 null。 */
export async function pickSkinFile(): Promise<string | null> {
  const picked = await dialog.showOpenDialog({
    title: mt("auth.skin.pickTitle"),
    properties: ["openFile"],
    filters: [{ name: mt("auth.skin.filterName"), extensions: ["png"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return picked.filePaths[0];
}

// ---------------------------------------------------------------- 衣柜（本地皮肤库）

/** 衣柜目录：<NaiWa>/skins。站点级衣柜接口不可达，所以衣柜完全落在本地。 */
function skinsDir(): string {
  return join(getPaths().dataRoot, "skins");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** IPC skins:wardrobe：列出衣柜里的 .png，按修改时间倒序（新的在前）。 */
export async function listWardrobe(): Promise<WardrobeSkin[]> {
  const dir = skinsDir();
  await mkdir(dir, { recursive: true });
  const names = await readdir(dir).catch(() => [] as string[]);
  const items: WardrobeSkin[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    // 目录/软链接都不算衣柜皮肤
    if (!info || !info.isFile()) continue;
    items.push({
      name,
      url: pathToFileURL(join(dir, name)).toString(),
      sizeBytes: info.size,
      updatedAt: info.mtimeMs,
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/** 文件名里不能出现的字符（Windows 保留字符 + 控制字符）统一换成下划线。 */
const WARDROBE_NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/g;

function wardrobeStem(filePath: string): string {
  const raw = basename(filePath, extname(filePath)).trim();
  const cleaned = raw.replace(WARDROBE_NAME_BAD, "_").replace(/^\.+/, "").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "skin";
}

/** IPC skins:addToWardrobe：校验后复制成 <原名>-<时间戳>.png，重名再加序号，绝不覆盖。 */
export async function addToWardrobe(filePath: string): Promise<string> {
  // 复用现有校验：必须是 64×64 或 64×32 的 PNG
  const bytes = await readSkinPng(filePath);
  const dir = skinsDir();
  await mkdir(dir, { recursive: true });
  const stem = wardrobeStem(filePath) + "-" + Date.now();
  let target = join(dir, stem + ".png");
  for (let index = 2; index <= 99 && (await fileExists(target)); index += 1) {
    target = join(dir, stem + "-" + index + ".png");
  }
  await writeFile(target, bytes);
  const name = basename(target);
  log.info("已加入衣柜：" + name + " · " + bytes.length + " 字节");
  return name;
}

/** 衣柜内的绝对路径；任何路径分隔符 / ".." 都当成穿越攻击直接拒绝。 */
function wardrobePath(name: string): string {
  const raw = (name ?? "").trim();
  if (raw.length === 0) throw new Error(mt("auth.skin.wardrobePickFirst"));
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw !== basename(raw)) {
    throw new Error(mt("auth.skin.wardrobeOutside", { name: raw }));
  }
  if (!raw.toLowerCase().endsWith(".png")) throw new Error(mt("auth.skin.wardrobePngOnly", { name: raw }));
  const dir = skinsDir();
  const target = join(dir, raw);
  // 双保险：解析后的父目录必须就是衣柜目录
  if (resolve(target, "..") !== resolve(dir)) throw new Error(mt("auth.skin.wardrobeOutside", { name: raw }));
  return target;
}

/** IPC skins:removeFromWardrobe：只删衣柜内的 .png；文件已不在时静默返回。 */
export async function removeFromWardrobe(name: string): Promise<void> {
  const target = wardrobePath(name);
  try {
    await unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw new Error(mt("auth.skin.deleteFailed", { name: basename(target), error: describe(err) }));
  }
  log.info("已从衣柜删除：" + basename(target));
}

// ---------------------------------------------------------------- 角色切换

/** UUID 比较：大小写、横线都不该影响判断。 */
function uuidKey(raw: unknown): string {
  return str(raw).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** IPC skins:profiles：第三方账号回存下的角色列表，微软只有当前档案，离线没有。 */
export async function listSkinProfiles(accountId: string): Promise<SkinProfile[]> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(mt("auth.account.notFound", { id: accountId }));
  if (account.type === "offline") return [];
  if (account.type === "microsoft") return [{ id: account.uuid, name: account.name, active: true }];
  const current = uuidKey(account.uuid);
  return (account.yggdrasil?.profiles ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    active: uuidKey(item.id) === current,
  }));
}

/** refresh 的失败文案：不带前缀，由调用方统一拼「切换角色失败：」。 */
function refreshFailure(reply: Reply): string {
  const body = reply.json ?? {};
  const message = str(body.errorMessage) || str(body.message) || str(body.error) || reply.text.slice(0, 200).trim();
  return "HTTP " + reply.status + (message ? " · " + message : "");
}

/**
 * IPC skins:selectProfile：第三方账号用 authserver/refresh 把令牌换成目标角色，
 * 再回写账号的 uuid/name。微软与离线账号没有多角色，直接拒绝。
 */
export async function selectProfile(accountId: string, profileId: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(mt("auth.account.notFound", { id: accountId }));
  const ygg = account.yggdrasil;
  if (account.type !== "yggdrasil" || !ygg?.apiUrl) throw new Error(noSwitchableProfile());

  const wanted = uuidKey(profileId);
  const profiles = ygg.profiles ?? [];
  const target = profiles.find((item) => uuidKey(item.id) === wanted);
  if (!target) throw new Error(mt("auth.skin.profileMissing", { id: profileId ?? "" }));

  try {
    const reply = await request(ygg.apiUrl.replace(/\/+$/, "") + "/authserver/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessToken: ygg.accessToken,
        clientToken: ygg.clientToken,
        selectedProfile: { id: target.id, name: target.name },
        requestUser: true,
      }),
    });
    if (reply.status !== 200) throw new Error(refreshFailure(reply));

    const body: Json = reply.json ?? {};
    const accessToken = str(body.accessToken);
    // 不换令牌的话注入后仍是旧角色，等同没切
    if (accessToken.length === 0) throw new Error(mt("auth.skin.refreshNoToken"));
    registerSecret(accessToken);
    const fresh: Json = body.selectedProfile && typeof body.selectedProfile === "object" ? (body.selectedProfile as Json) : {};
    const name = str(fresh.name) || target.name;

    await updateYggdrasilProfile(account.id, {
      uuid: target.id,
      name,
      accessToken,
      clientToken: str(body.clientToken) || ygg.clientToken,
      profiles: profiles.map((item) => ({ id: item.id, name: item.name })),
    });
    log.info("已切换角色：" + name + " · " + ygg.apiUrl);
  } catch (err) {
    throw new Error(mt("auth.skin.switchFailed", { error: describe(err) }));
  }
}
