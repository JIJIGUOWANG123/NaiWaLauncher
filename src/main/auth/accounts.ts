import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Account } from "../../shared/types";
import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { updateSettings } from "../core/settings";

const log = logger("accounts");

/** accounts.json 的磁盘结构。 */
export interface AccountStore {
  accounts: Account[];
  activeId: string;
}

/** 正版昵称规则：3–16 位字母、数字或下划线。 */
const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
/** Account.uuid 约定为无横线 32 位十六进制。 */
const UUID_PATTERN = /^[0-9a-f]{32}$/;

let cache: AccountStore | null = null;
/** 写盘串行化：并发写同一临时文件会互相覆盖。 */
let writeQueue: Promise<void> = Promise.resolve();

function storeFile(): string {
  return join(getPaths().config, "accounts.json");
}

function emptyStore(): AccountStore {
  return { accounts: [], activeId: "" };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 离线 UUID：Java 的 UUID.nameUUIDFromBytes("OfflinePlayer:<name>")。
 * md5 摘要改版本位为 3、变体位为 RFC-4122，输出 32 位无横线。
 */
export function offlineUuid(name: string): string {
  const digest = createHash("md5").update("OfflinePlayer:" + name, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return digest.toString("hex");
}

/**
 * 第三方角色列表规范化：只保留「32 位无横线 UUID + 非空名字」的条目，
 * 服务端多塞的字段一律丢掉，坏条目单独丢弃而不影响整份列表。
 */
function normalizeProfiles(raw: unknown): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const list: { id: string; name: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, unknown>;
    const id = typeof src.id === "string" ? src.id.replace(/[^0-9a-fA-F]/g, "").toLowerCase() : "";
    const name = typeof src.name === "string" ? src.name : "";
    if (!UUID_PATTERN.test(id) || !name) continue;
    if (list.some((p) => p.id === id)) continue;
    list.push({ id, name });
  }
  return list;
}

function normalizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const id = typeof src.id === "string" ? src.id : "";
  const name = typeof src.name === "string" ? src.name : "";
  const uuid = typeof src.uuid === "string" ? src.uuid.toLowerCase() : "";
  if (!id || !name || !UUID_PATTERN.test(uuid)) return null;

  const account: Account = {
    id,
    type: src.type === "microsoft" ? "microsoft" : src.type === "yggdrasil" ? "yggdrasil" : "offline",
    name,
    uuid,
    createdAt: typeof src.createdAt === "number" ? src.createdAt : Date.now(),
  };
  if (typeof src.lastUsedAt === "number") account.lastUsedAt = src.lastUsedAt;

  if (account.type === "microsoft") {
    const ms = src.microsoft && typeof src.microsoft === "object" ? (src.microsoft as Record<string, unknown>) : {};
    const refreshToken = typeof ms.refreshToken === "string" ? ms.refreshToken : "";
    // 没有 refresh token 的微软账号永远刷不出令牌，直接丢弃，避免界面出现点不动的账号
    if (!refreshToken) return null;
    account.microsoft = {
      refreshToken,
      accessToken: typeof ms.accessToken === "string" ? ms.accessToken : "",
      expiresAt: typeof ms.expiresAt === "number" ? ms.expiresAt : 0,
    };
    if (typeof ms.xuid === "string") account.microsoft.xuid = ms.xuid;
  }

  if (account.type === "yggdrasil") {
    const ygg = src.yggdrasil && typeof src.yggdrasil === "object" ? (src.yggdrasil as Record<string, unknown>) : {};
    const apiUrl = typeof ygg.apiUrl === "string" ? ygg.apiUrl.trim() : "";
    const accessToken = typeof ygg.accessToken === "string" ? ygg.accessToken : "";
    // 没有 API 地址或令牌的第三方账号既登不进也启动不了，直接丢弃，避免界面出现点不动的账号
    if (!apiUrl || !accessToken) return null;
    account.yggdrasil = {
      apiUrl,
      accessToken,
      clientToken: typeof ygg.clientToken === "string" ? ygg.clientToken : "",
      expiresAt: typeof ygg.expiresAt === "number" ? ygg.expiresAt : 0,
    };
    if (typeof ygg.siteName === "string" && ygg.siteName.length > 0) account.yggdrasil.siteName = ygg.siteName;
    // 角色切换列表必须落盘，否则重启后又只剩当前角色
    const profiles = normalizeProfiles(ygg.profiles);
    if (profiles.length > 0) account.yggdrasil.profiles = profiles;
  }
  return account;
}

/** 逐字段校验：坏条目丢弃而不是整体失败，剩余账号仍可用。 */
function normalizeStore(raw: unknown): AccountStore {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(src.accounts) ? src.accounts : [];
  const accounts: Account[] = [];
  for (const item of list) {
    const account = normalizeAccount(item);
    if (account) accounts.push(account);
  }
  const rawActive = typeof src.activeId === "string" ? src.activeId : "";
  return { accounts, activeId: accounts.some((a) => a.id === rawActive) ? rawActive : "" };
}

function clone(account: Account): Account {
  const copy: Account = { ...account };
  if (account.microsoft) copy.microsoft = { ...account.microsoft };
  if (account.yggdrasil) {
    copy.yggdrasil = { ...account.yggdrasil };
    // 数组要独立拷贝：调用方改到 profiles 不能污染缓存
    if (account.yggdrasil.profiles) copy.yggdrasil.profiles = account.yggdrasil.profiles.map((p) => ({ ...p }));
  }
  return copy;
}

async function writeAtomic(next: AccountStore): Promise<void> {
  const file = storeFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now().toString(36) + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    // rename 原子替换：崩溃时不会留下半截 json
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function load(): Promise<AccountStore> {
  if (cache) return cache;
  let text: string;
  try {
    text = await readFile(storeFile(), "utf8");
  } catch {
    cache = emptyStore();
    return cache;
  }
  try {
    cache = normalizeStore(JSON.parse(text));
  } catch {
    log.warn("账号文件损坏，已回退为空列表");
    cache = emptyStore();
  }
  return cache;
}

function persist(next: AccountStore): Promise<void> {
  // 先写缓存：调用方在写盘完成前应读到新状态
  cache = next;
  const run = writeQueue.then(() => writeAtomic(next), () => writeAtomic(next));
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function listAccounts(): Promise<Account[]> {
  const store = await load();
  return store.accounts.map(clone);
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const store = await load();
  const found = store.accounts.find((a) => a.id === id);
  return found ? clone(found) : undefined;
}

export async function createOffline(name: string): Promise<Account> {
  const trimmed = name.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error("玩家名必须是 3–16 位字母、数字或下划线");
  }
  const store = await load();
  const lower = trimmed.toLowerCase();
  if (store.accounts.some((a) => a.name.toLowerCase() === lower)) {
    throw new Error("已存在同名账号：" + trimmed);
  }

  const account: Account = {
    id: randomUUID(),
    type: "offline",
    name: trimmed,
    uuid: offlineUuid(trimmed),
    createdAt: Date.now(),
  };
  const next: AccountStore = {
    accounts: [...store.accounts, account],
    // 第一个账号自动成为当前账号，界面不必再要求用户选一次
    activeId: store.activeId || account.id,
  };
  await persist(next);
  if (!store.activeId) await syncActiveSetting(account.id);
  return clone(account);
}

export async function removeAccount(id: string): Promise<void> {
  const store = await load();
  const accounts = store.accounts.filter((a) => a.id !== id);
  if (accounts.length === store.accounts.length) return;
  const activeId = store.activeId === id ? "" : store.activeId;
  await persist({ accounts, activeId });
  if (store.activeId === id) await syncActiveSetting("");
}

export async function setActiveAccount(id: string): Promise<void> {
  const store = await load();
  const target = store.accounts.find((a) => a.id === id);
  if (!target) throw new Error("账号不存在：" + id);
  const accounts = store.accounts.map((a) => (a.id === id ? { ...a, lastUsedAt: Date.now() } : a));
  await persist({ accounts, activeId: id });
  await syncActiveSetting(id);
}

export async function getActiveAccount(): Promise<Account | undefined> {
  const store = await load();
  const found = store.accounts.find((a) => a.id === store.activeId);
  return found ? clone(found) : undefined;
}

/** settings.activeAccountId 跟随账号选择，避免两处状态互相打架。 */
async function syncActiveSetting(activeAccountId: string): Promise<void> {
  try {
    await updateSettings({ activeAccountId });
  } catch (err) {
    log.error("同步 activeAccountId 失败：" + describe(err));
    throw err;
  }
}

export interface MicrosoftAccountInput {
  name: string;
  /** 无横线 32 位档案 id。 */
  uuid: string;
  refreshToken: string;
  /** 微软 access token（oauth token 端点签发）。 */
  accessToken: string;
  expiresAt: number;
  xuid?: string;
}

/** 同一档案重复登录时更新既有账号，只有新档案才追加，并自动设为当前账号。 */
export async function upsertMicrosoftAccount(input: MicrosoftAccountInput): Promise<Account> {
  const store = await load();
  const uuid = input.uuid.toLowerCase();
  const existing = store.accounts.find((a) => a.type === "microsoft" && a.uuid === uuid);
  const microsoft: NonNullable<Account["microsoft"]> = {
    refreshToken: input.refreshToken,
    accessToken: input.accessToken,
    expiresAt: input.expiresAt,
  };
  if (input.xuid) microsoft.xuid = input.xuid;

  let account: Account;
  let accounts: Account[];
  if (existing) {
    account = { ...existing, name: input.name, uuid, microsoft, lastUsedAt: Date.now() };
    accounts = store.accounts.map((a) => (a.id === existing.id ? account : a));
  } else {
    account = {
      id: randomUUID(),
      type: "microsoft",
      name: input.name,
      uuid,
      createdAt: Date.now(),
      microsoft,
    };
    accounts = [...store.accounts, account];
  }

  await persist({ accounts, activeId: account.id });
  await syncActiveSetting(account.id);
  return clone(account);
}

/** 刷新后覆盖令牌：refresh token 每次轮换，必须立刻落盘。 */
export async function updateMicrosoftTokens(
  id: string,
  tokens: { refreshToken: string; accessToken: string; expiresAt: number; xuid?: string },
): Promise<Account> {
  const store = await load();
  const existing = store.accounts.find((a) => a.id === id);
  if (!existing || existing.type !== "microsoft") throw new Error("微软账号不存在：" + id);
  const microsoft: NonNullable<Account["microsoft"]> = {
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  };
  const xuid = tokens.xuid ?? existing.microsoft?.xuid;
  if (xuid) microsoft.xuid = xuid;
  const account: Account = { ...existing, microsoft };
  const accounts = store.accounts.map((a) => (a.id === id ? account : a));
  await persist({ accounts, activeId: store.activeId });
  return clone(account);
}

export interface YggdrasilAccountInput {
  /** 规范化后的 API 根地址（含 /api/yggdrasil）。 */
  apiUrl: string;
  /** 角色名（selectedProfile.name）。 */
  name: string;
  /** 无横线 32 位角色 UUID。 */
  uuid: string;
  accessToken: string;
  clientToken: string;
  expiresAt: number;
  siteName?: string;
  /** authenticate 返回的全部角色（availableProfiles，只有 selectedProfile 时就是那一条）。 */
  profiles?: { id: string; name: string }[];
}

/** 同一站点、同一角色重复登录时更新既有账号，只有新角色才追加，并自动设为当前账号。 */
export async function upsertYggdrasilAccount(input: YggdrasilAccountInput): Promise<Account> {
  const store = await load();
  const apiUrl = input.apiUrl.trim();
  if (!apiUrl) throw new Error("第三方账号缺少 API 地址");
  const uuid = input.uuid.toLowerCase();
  const existing = store.accounts.find(
    (a) => a.type === "yggdrasil" && a.yggdrasil?.apiUrl === apiUrl && a.uuid === uuid,
  );

  const yggdrasil: NonNullable<Account["yggdrasil"]> = {
    apiUrl,
    accessToken: input.accessToken,
    clientToken: input.clientToken,
    expiresAt: input.expiresAt,
  };
  if (input.siteName) yggdrasil.siteName = input.siteName;
  const profiles = normalizeProfiles(input.profiles);
  if (profiles.length > 0) yggdrasil.profiles = profiles;

  let account: Account;
  let accounts: Account[];
  if (existing) {
    account = { ...existing, name: input.name, uuid, yggdrasil, lastUsedAt: Date.now() };
    accounts = store.accounts.map((a) => (a.id === existing.id ? account : a));
  } else {
    account = {
      id: randomUUID(),
      type: "yggdrasil",
      name: input.name,
      uuid,
      createdAt: Date.now(),
      yggdrasil,
    };
    accounts = [...store.accounts, account];
  }

  await persist({ accounts, activeId: account.id });
  await syncActiveSetting(account.id);
  return clone(account);
}

export interface YggdrasilProfilePatch {
  /** 切换后的角色 UUID（无横线 32 位）。 */
  uuid?: string;
  /** 切换后的角色名。 */
  name?: string;
  accessToken?: string;
  clientToken?: string;
  /** 该账号的全部角色（留在账号上，下次切换不必重新登录）。 */
  profiles?: { id: string; name: string }[];
}

/**
 * 切换角色后回写账号：uuid/name 换成新角色，令牌一并更新。
 * 调用方（skin.ts）已经过 authserver/refresh，这里只负责落盘。
 */
export async function updateYggdrasilProfile(id: string, patch: YggdrasilProfilePatch): Promise<Account> {
  const store = await load();
  const existing = store.accounts.find((a) => a.id === id);
  if (!existing || existing.type !== "yggdrasil" || !existing.yggdrasil) throw new Error("第三方账号不存在：" + id);

  const uuid = (patch.uuid ?? existing.uuid).toLowerCase();
  if (!UUID_PATTERN.test(uuid)) throw new Error("角色 UUID 不合法：" + uuid);
  const name = patch.name ?? existing.name;
  if (!name) throw new Error("角色名不能为空");

  const yggdrasil: NonNullable<Account["yggdrasil"]> = { ...existing.yggdrasil };
  if (patch.accessToken) yggdrasil.accessToken = patch.accessToken;
  if (patch.clientToken) yggdrasil.clientToken = patch.clientToken;
  const profiles = normalizeProfiles(patch.profiles ?? yggdrasil.profiles);
  if (profiles.length > 0) yggdrasil.profiles = profiles;

  const account: Account = { ...existing, uuid, name, yggdrasil };
  const accounts = store.accounts.map((a) => (a.id === id ? account : a));
  await persist({ accounts, activeId: store.activeId });
  return clone(account);
}

/** 续期后覆盖令牌：refresh 可能轮换 clientToken，必须立刻落盘。 */
export async function updateYggdrasilTokens(
  id: string,
  tokens: { accessToken: string; clientToken: string; expiresAt: number; siteName?: string },
): Promise<Account> {
  const store = await load();
  const existing = store.accounts.find((a) => a.id === id);
  if (!existing || existing.type !== "yggdrasil" || !existing.yggdrasil) throw new Error("第三方账号不存在：" + id);
  const yggdrasil: NonNullable<Account["yggdrasil"]> = {
    ...existing.yggdrasil,
    accessToken: tokens.accessToken,
    clientToken: tokens.clientToken,
    expiresAt: tokens.expiresAt,
  };
  const siteName = tokens.siteName ?? existing.yggdrasil.siteName;
  if (siteName) yggdrasil.siteName = siteName;
  const account: Account = { ...existing, yggdrasil };
  const accounts = store.accounts.map((a) => (a.id === id ? account : a));
  await persist({ accounts, activeId: store.activeId });
  return clone(account);
}
