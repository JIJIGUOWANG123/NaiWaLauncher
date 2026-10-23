// 本地皮肤 API（只给离线账号用）：在 127.0.0.1 上实现 authlib-injector 需要的最小接口集合。
// 启动游戏时注入 -javaagent:authlib-injector.jar=http://127.0.0.1:<port>，客户端就会把「会话服务器 / 材质」
// 请求转到本进程 —— 不装 CustomSkinLoader 也能用本地皮肤与披风。
// 端点（按 authlib-injector 的 API 约定）：
//   GET  /                                             → metadata（serverName / implementationName / implementationVersion / skinDomains / signaturePublickey）
//   POST /authserver/authenticate                      → 登录（离线场景基本用不到，给最小可用响应）
//   POST /authserver/validate | /refresh | /invalidate → 204 空实现
//   POST /sessionserver/session/minecraft/join         → 204 空实现
//   GET  /sessionserver/session/minecraft/profile/{id} → { id, name, properties:[{ name:"textures", value:base64 }] }
//   GET  /textures/{sha1}.png                          → 皮肤/披风字节（只从内存白名单取）
// 安全约束（改动时必须保持）：
//   · 只监听 127.0.0.1、端口随机；
//   · 方法白名单（只有上面这些 GET/POST），其余一律 405；未知路径 404；
//   · 材质只从内存里的 assets 白名单返回，绝不按请求路径读盘（否则就成了任意文件读取）。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "../core/logger";
import { selectedLocalCape } from "./capes";
import { selectedLocalSkin } from "./local";
import { mt } from "../core/i18n";

const log = logger("skins");

function serverName(): string {
  return mt("skins.localServerName");
}
const IMPLEMENTATION_NAME = "NaiWa Launcher local skin API";
const IMPLEMENTATION_VERSION = "0.2.2";
/** 请求体上限：认证请求只有几百字节，超了直接当空体处理。 */
const MAX_BODY_BYTES = 64 * 1024;

interface Asset {
  bytes: Buffer;
}

/** 材质白名单：sha1 → 字节。URL 只能是这里已有的键，杜绝按路径读盘。 */
const assets = new Map<string, Asset>();

interface ProfileBinding {
  accountId: string;
  /** 游戏里的玩家名。 */
  name: string;
  /** 无横线的 uuid（与 sessionserver 规范一致）。 */
  uuid: string;
}

/** uuid（无横线）→ 账号绑定。只有启动时登记过的离线账号才会出现在这里。 */
const profiles = new Map<string, ProfileBinding>();

let server: Server | null = null;
let baseUrl: string | undefined;
let starting: Promise<{ baseUrl: string; port: number } | null> | null = null;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeUuid(raw: string): string {
  return String(raw ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

/** 读请求体（限长）；不是合法 JSON 就当空对象 —— 离线场景基本用不到这些端点。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) return {};
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 登记材质并返回内容 id（sha1）；同一张图重复登记是幂等的。 */
function registerAsset(bytes: Buffer): string {
  const id = createHash("sha1").update(bytes).digest("hex");
  if (!assets.has(id)) assets.set(id, { bytes });
  return id;
}

/** 启动前登记：这个 uuid 用哪个账号的皮肤/披风。重复登记覆盖即可。 */
export function registerOfflineProfile(binding: { accountId: string; name: string; uuid: string }): void {
  const uuid = normalizeUuid(binding.uuid);
  if (!uuid || !binding.accountId) return;
  profiles.set(uuid, { accountId: binding.accountId, name: binding.name, uuid });
}

/**
 * 生成 profile 响应：textures 里的 SKIN/CAPE 指向本服务的 /textures/{sha1}.png。
 * 账号没有选本地皮肤/披风时不带对应条目（游戏会退回默认材质）。
 */
async function profilePayload(uuid: string): Promise<unknown | undefined> {
  const binding = profiles.get(uuid);
  if (!binding) return undefined;
  const base = baseUrl ?? "";
  const textures: Record<string, unknown> = {};
  try {
    const skin = await selectedLocalSkin(binding.accountId);
    if (skin) {
      const bytes = await readFile(skin.path);
      const node: Record<string, unknown> = { url: base + "/textures/" + registerAsset(bytes) + ".png" };
      // 只有细臂才写 metadata.model（与 Mojang 的约定一致：不写就是 classic）
      if (skin.model === "slim") node.metadata = { model: "slim" };
      textures.SKIN = node;
    }
    const cape = await selectedLocalCape(binding.accountId);
    if (cape) {
      const bytes = await readFile(cape.path);
      textures.CAPE = { url: base + "/textures/" + registerAsset(bytes) + ".png" };
    }
  } catch (err) {
    log.warn("本地皮肤 API 读取材质失败：" + messageOf(err));
  }
  const payload = {
    timestamp: Date.now(),
    profileId: binding.uuid,
    profileName: binding.name,
    textures,
  };
  const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return { id: binding.uuid, name: binding.name, properties: [{ name: "textures", value }] };
}

const METADATA = {
  meta: {
    serverName: serverName(),
    implementationName: IMPLEMENTATION_NAME,
    implementationVersion: IMPLEMENTATION_VERSION,
  },
  // 材质与 API 同源（同一个 127.0.0.1 端口），不需要额外放行域名；没有签名密钥，材质不带签名
  skinDomains: [] as string[],
  signaturePublickey: "",
};

const AUTH_NOOP = new Set(["/authserver/validate", "/authserver/refresh", "/authserver/invalidate"]);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = decodeURIComponent(parsed.pathname);

  if (route === "/") {
    if (method !== "GET") return sendEmpty(res, 405);
    return sendJson(res, 200, METADATA);
  }

  if (route === "/authserver/authenticate") {
    if (method !== "POST") return sendEmpty(res, 405);
    const body = await readJsonBody(req);
    const wanted = typeof body.username === "string" ? body.username.toLowerCase() : "";
    const candidates = Array.from(profiles.values());
    const chosen = candidates.find((item) => item.name.toLowerCase() === wanted) ?? candidates[0];
    if (!chosen) return sendEmpty(res, 403);
    const clientToken = typeof body.clientToken === "string" && body.clientToken ? body.clientToken : "naiwa-local";
    return sendJson(res, 200, {
      accessToken: "0",
      clientToken,
      availableProfiles: [{ id: chosen.uuid, name: chosen.name }],
      selectedProfile: { id: chosen.uuid, name: chosen.name },
    });
  }

  if (AUTH_NOOP.has(route)) {
    if (method !== "POST") return sendEmpty(res, 405);
    return sendEmpty(res, 204);
  }

  if (route === "/sessionserver/session/minecraft/join") {
    if (method !== "POST") return sendEmpty(res, 405);
    return sendEmpty(res, 204);
  }

  const profileMatch = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-fA-F-]{32,36})$/.exec(route);
  if (profileMatch) {
    if (method !== "GET") return sendEmpty(res, 405);
    const body = await profilePayload(normalizeUuid(profileMatch[1]));
    // 204 = 没有这个角色（authlib-injector 的约定，与第三方站一致）
    return body ? sendJson(res, 200, body) : sendEmpty(res, 204);
  }

  const textureMatch = /^\/textures\/([0-9a-f]{40})\.png$/.exec(route);
  if (textureMatch) {
    if (method !== "GET") return sendEmpty(res, 405);
    const asset = assets.get(textureMatch[1]);
    if (!asset) return sendEmpty(res, 404);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(asset.bytes.length),
      "cache-control": "no-store",
    });
    return void res.end(asset.bytes);
  }

  return sendEmpty(res, 404);
}

/** 启动本地皮肤 API（幂等）：已经在跑就返回同一个地址。 */
export async function startSkinApi(): Promise<{ baseUrl: string; port: number } | null> {
  if (server && baseUrl) return { baseUrl, port: Number(new URL(baseUrl).port) };
  if (starting) return starting;
  starting = (async () => {
    try {
      const srv = createServer((req, res) => {
        void handle(req, res).catch((err: unknown) => {
          log.warn("本地皮肤 API 请求失败：" + messageOf(err));
          try {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          } catch {
            /* 连接已断开 */
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        // 端口传 0：由系统分配，并且只绑定回环地址
        srv.listen(0, "127.0.0.1", () => resolve());
      });
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      if (!port) {
        srv.close();
        return null;
      }
      server = srv;
      baseUrl = "http://127.0.0.1:" + port;
      log.info("本地皮肤 API 已启动：" + baseUrl);
      return { baseUrl, port };
    } catch (err) {
      log.warn("本地皮肤 API 启动失败：" + messageOf(err));
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** 当前地址；没启动时为 undefined。 */
export function skinApiBaseUrl(): string | undefined {
  return baseUrl;
}

/** 关闭服务（launcher 退出时调用）。 */
export async function stopSkinApi(): Promise<void> {
  const srv = server;
  server = null;
  baseUrl = undefined;
  if (!srv) return;
  const withConnections = srv as Server & { closeAllConnections?: () => void };
  withConnections.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
  log.info("本地皮肤 API 已关闭");
}
