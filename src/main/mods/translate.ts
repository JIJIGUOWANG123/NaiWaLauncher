// 模组名/简介的实时翻译：主 uapis.cn（单条、按 IP 强限流）+ 备 suapi.net（支持批量）。
// 统一策略：全局串行 + 最小间隔、正/负缓存、主备自动切换；任何失败都降级为「留空」，绝不打断搜索与详情。
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../core/logger";
import { getPaths } from "../core/paths";
import { getSettings } from "../core/settings";
import { jsonArray, jsonNumber, jsonObject, jsonString, messageOf } from "./provider";
import { mt } from "../core/i18n";

const log = logger("translate");

type ProviderId = "deepl" | "uapis" | "suapi";

const DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate";
const DEEPL_PRO_URL = "https://api.deepl.com/v2/translate";
const UAPIS_URL = "https://uapis.cn/api/v1/translate/text";
const SUAPI_URL = "https://suapi.net/api/text/translate";
/** 单次批量上限：suapi 20 条、DeepL 50 条；uapis 只有单条接口。 */
const SUAPI_BATCH = 20;
const DEEPL_BATCH = 50;
const PROVIDER_LABEL: Record<ProviderId, string> = {
  deepl: "DeepL",
  uapis: "uapis.cn",
  suapi: "suapi.net",
};
/** 默认主接口。 */
const DEFAULT_PROVIDER: ProviderId = "uapis";
/** 切换后保持 10 分钟，之后允许回切主接口。 */
const PREFERRED_STICKY_MS = 10 * 60_000;

/** 接口上限：超过 3000 字符会被直接拒绝，所以先截断再发。 */
const MAX_TEXT_CHARS = 3000;
const TIMEOUT_MS = 6_000;
/** DeepL 响应慢一些，给 8s。 */
const DEEPL_TIMEOUT_MS = 8_000;
/** 全局最小请求间隔：所有搜索/详情共用一条队列，避免把限流打成连击。 */
const MIN_INTERVAL_MS = 150;
/** 失败结果 5 分钟内不再重试（按 provider 分别记）：限流期间反复撞墙只会更糟。 */
const NEGATIVE_TTL_MS = 5 * 60_000;

const CACHE_FILE = "translate-cache.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 2000;

/** 判断搜索词是否需要先译成英文。 */
const CJK_RE = /[\u4e00-\u9fff]/;

interface CacheEntry {
  /** 译文。 */
  t: string;
  /** 写入时间（毫秒）：TTL 与容量裁剪都按它排序。 */
  at: number;
}

const cache = new Map<string, CacheEntry>();
/** 负缓存：`${provider}|${key}` → 失败时间。只存内存，重启即清空。 */
const negative = new Map<string, number>();
let loaded = false;
let loading: Promise<void> | null = null;
/** 写盘串行化：并发翻译只留最后一次的完整快照，不互相覆盖临时文件。 */
let writeQueue: Promise<void> = Promise.resolve();
/** 请求队列：同一时刻只有一个在飞，且相邻两次至少间隔 MIN_INTERVAL_MS。 */
let chain: Promise<void> = Promise.resolve();
let lastStartAt = 0;
let requests = 0;
/** uapis / suapi 之间的当前首选接口。 */
let preferred: ProviderId = DEFAULT_PROVIDER;
let stickyUntil = 0;
/** DeepL Key 无效（401/403）或额度用尽（456）后本进程内不再尝试。 */
let deeplDisabled = false;

/** 已发出的翻译请求数（自检统计真实请求数用）。 */
export function translateRequestCount(): number {
  return requests;
}

/** 负缓存里的条数（自检用）。 */
export function translateNegativeCount(): number {
  return negative.size;
}

/** 当前首选接口（自检用）。 */
export function getPreferredProvider(): ProviderId {
  return preferred;
}

/** 自检用：强制指定首选接口。 */
export function setPreferredProvider(id: ProviderId): void {
  preferred = id;
  stickyUntil = Date.now() + PREFERRED_STICKY_MS;
}

/** 清空进程内缓存（自检脚本用；磁盘文件下次写入时自然被覆盖）。 */
export function clearTranslateCache(): void {
  cache.clear();
  negative.clear();
  loaded = false;
  loading = null;
}

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 全局串行 + 最小间隔。 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    // 上一次请求已经结束了，等待只需要补足间隔；夹住上限，避免系统时间跳变后傻等
    const wait = Math.min(MIN_INTERVAL_MS, MIN_INTERVAL_MS - (Date.now() - lastStartAt));
    if (wait > 0) await sleep(wait);
    lastStartAt = Date.now();
    return task();
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** 配置了 DeepL Key 且没被判失效时，DeepL 排最前。 */
function deeplKey(): string {
  if (deeplDisabled) return "";
  const key = getSettings().deeplApiKey;
  return typeof key === "string" ? key.trim() : "";
}

/** 完整尝试顺序：DeepL（有 Key 时）→ 首选接口 → 兜底接口。 */
function providerOrder(): ProviderId[] {
  if (preferred !== DEFAULT_PROVIDER && Date.now() >= stickyUntil) preferred = DEFAULT_PROVIDER;
  const base: ProviderId[] = preferred === "uapis" ? ["uapis", "suapi"] : ["suapi", "uapis"];
  return deeplKey() ? ["deepl", ...base] : base;
}

/** 自检/诊断用：当前实际会尝试的顺序。 */
export function getProviderOrder(): ProviderId[] {
  return providerOrder();
}

function reasonOf(err: unknown): string {
  const status = statusOf(err);
  if (status !== null) return String(status);
  return messageOf(err).slice(0, 40);
}

function switchPreferenceTo(next: ProviderId, reason: string): void {
  preferred = next;
  stickyUntil = Date.now() + PREFERRED_STICKY_MS;
  log.warn(`主接口失败（${reason}），本次改用 ${PROVIDER_LABEL[next]}`);
}

/** 缓存文件位置；路径未初始化时只走内存，不能因此抛错。 */
function cachePath(): string | null {
  try {
    return join(getPaths().meta, CACHE_FILE);
  } catch {
    return null;
  }
}

function cacheKey(text: string, toLang: string): string {
  return `${toLang}:${createHash("sha1").update(text, "utf8").digest("hex")}`;
}

function negativeKey(provider: ProviderId, key: string): string {
  return `${provider}|${key}`;
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

function parseEntries(raw: unknown): Map<string, CacheEntry> {
  const out = new Map<string, CacheEntry>();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const now = Date.now();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as { t?: unknown; at?: unknown };
    if (typeof entry.t !== "string" || typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
    // 过期条目直接不加载，也就不会参与后续写盘的合并
    if (now - entry.at >= CACHE_TTL_MS) continue;
    out.set(key, { t: entry.t, at: entry.at });
  }
  return out;
}

/** 读盘失败（不存在/损坏/无权限）一律当空：缓存不是数据源。 */
async function readDiskCache(file: string): Promise<Map<string, CacheEntry>> {
  try {
    return parseEntries(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return new Map();
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  loaded = true;
  const file = cachePath();
  if (!file) {
    loading = Promise.resolve();
    return loading;
  }
  loading = readDiskCache(file)
    .then((disk) => {
      for (const [key, entry] of disk) cache.set(key, entry);
      trim();
    })
    .catch(() => undefined);
  return loading;
}

/** 先剔过期，再按写入时间淘汰最旧的，保证条目数不超过上限。 */
function trim(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const ordered = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of ordered.slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
}

async function writeSnapshot(): Promise<void> {
  const file = cachePath();
  if (!file) return;
  try {
    // 写盘前并入磁盘上的现有条目：多次运行之间不互相覆盖
    for (const [key, entry] of await readDiskCache(file)) {
      const mine = cache.get(key);
      if (!mine || mine.at < entry.at) cache.set(key, entry);
    }
    trim();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(cache)), "utf8");
    // rename 是原子替换：崩溃时不会留下半截 json
    await rename(tmp, file);
  } catch (err) {
    log.warn(`写入翻译缓存失败（忽略）：${messageOf(err)}`);
  }
}

function persist(): Promise<void> {
  const run = writeQueue.then(writeSnapshot, writeSnapshot);
  writeQueue = run.catch(() => undefined);
  return run;
}

function statusOf(err: unknown): number | null {
  if (err !== null && typeof err === "object" && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function negativeHit(provider: ProviderId, key: string): boolean {
  const at = negative.get(negativeKey(provider, key));
  if (at === undefined) return false;
  if (Date.now() - at >= NEGATIVE_TTL_MS) {
    negative.delete(negativeKey(provider, key));
    return false;
  }
  return true;
}

function markNegative(provider: ProviderId, key: string): void {
  if (negative.size >= CACHE_MAX_ENTRIES) {
    const oldest = negative.keys().next();
    if (!oldest.done) negative.delete(oldest.value);
  }
  negative.set(negativeKey(provider, key), Date.now());
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  requests += 1;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // 正文必须读掉，否则连接不释放
      await res.text().catch(() => "");
      throw httpError(res.status, mt("mods.translateHttp", { url, status: res.status }));
    }
    return (await res.json()) as unknown;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw httpError(0, mt("mods.translateTimeout", { ms: timeoutMs }));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 主接口：单条。 */
async function postUapis(text: string, toLang: string): Promise<string> {
  const body = await fetchJsonWithTimeout(UAPIS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ text, to_lang: toLang }),
  });
  const translated = jsonString(jsonObject(body).translate);
  if (!translated.trim()) throw httpError(0, mt("mods.translateEmpty"));
  return translated;
}

/** 备接口：一次一串，to 用 zh-CHS / en。 */
async function postSuapi(texts: string[], toLang: string): Promise<(string | undefined)[]> {
  const chinese = toLang.toLowerCase().startsWith("zh");
  const to = chinese ? "zh-CHS" : toLang.toLowerCase();
  const query = `?to=${encodeURIComponent(to)}${chinese ? "&from=en" : ""}`;
  const body = await fetchJsonWithTimeout(`${SUAPI_URL}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", referer: "https://suapi.net" },
    body: JSON.stringify(texts),
  });
  const payload = jsonObject(body);
  const code = jsonNumber(payload.code);
  // code 不是 200 一律当整批失败：主备切换由上层负责
  if (code !== 200) throw httpError(0, mt("mods.translateUnexpectedCode", { code: jsonString(payload.code) || "?" }));
  const data = jsonArray(payload.data).map(jsonObject);
  return texts.map((_, index) => {
    const first = jsonObject(jsonArray(jsonObject(data[index]).translations)[0]);
    const translated = jsonString(first.text);
    return translated.trim() ? translated : undefined;
  });
}

/** DeepL：表单编码，多个 text 字段追加；译文按顺序取 translations[i].text。 */
async function postDeepl(texts: string[], toLang: string): Promise<(string | undefined)[]> {
  const key = deeplKey();
  if (!key) throw httpError(401, mt("mods.translateNoKey"));
  const chinese = toLang.toLowerCase().startsWith("zh");
  const form = new URLSearchParams();
  for (const text of texts) form.append("text", text);
  form.append("target_lang", chinese ? "ZH" : "EN");
  // 中方向固定 source_lang=EN 更稳；反向交给 DeepL 自动识别
  if (chinese) form.append("source_lang", "EN");
  const url = key.endsWith(":fx") ? DEEPL_FREE_URL : DEEPL_PRO_URL;
  const body = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: `DeepL-Auth-Key ${key}`,
      },
      body: form.toString(),
    },
    DEEPL_TIMEOUT_MS,
  );
  const translations = jsonArray(jsonObject(body).translations).map(jsonObject);
  return texts.map((_, index) => {
    const translated = jsonString(translations[index].text);
    return translated.trim() ? translated : undefined;
  });
}

function requestProvider(provider: ProviderId, texts: string[], toLang: string): Promise<(string | undefined)[]> {
  return serialize(async () => {
    if (provider === "deepl") return postDeepl(texts, toLang);
    if (provider === "suapi") return postSuapi(texts, toLang);
    return [await postUapis(texts[0], toLang)];
  });
}

/** 每个提供方单次能塞多少条。 */
function providerBatch(provider: ProviderId): number {
  if (provider === "uapis") return 1;
  return provider === "deepl" ? DEEPL_BATCH : SUAPI_BATCH;
}

/** 按 provider 的分批能力把一批文本发完；任一批失败直接抛出，让上层切主备。 */
async function callProvider(
  provider: ProviderId,
  texts: string[],
  toLang: string,
  assign: (index: number, value: string) => void,
): Promise<void> {
  const size = providerBatch(provider);
  for (let start = 0; start < texts.length; start += size) {
    const chunk = texts.slice(start, start + size);
    const values = await requestProvider(provider, chunk, toLang);
    values.forEach((value, offset) => {
      if (typeof value === "string" && value.trim()) assign(start + offset, value);
    });
  }
}

/**
 * 批量翻译：正缓存 → 主接口 → 备接口，逐个降级；两个接口都失败就是 undefined（调用方保留原文）。
 * 相同的文本只翻一次；两个接口都进负缓存的文本直接跳过，不再发请求。
 */
export async function translateBatch(texts: string[], toLang: string): Promise<(string | undefined)[]> {
  const target = String(toLang ?? "").trim();
  if (!target) throw new Error(mt("mods.missingTargetLang"));
  const out: (string | undefined)[] = new Array(texts.length).fill(undefined);
  if (texts.length === 0) return out;
  await ensureLoaded();

  const unique: string[] = [];
  const slots = new Map<string, number[]>();
  texts.forEach((raw, index) => {
    const text = clip(String(raw ?? ""));
    if (!text.trim()) {
      out[index] = "";
      return;
    }
    // 已经是中文就不再请求中文译文：省一次请求，也避免译文被反写
    if (target.toLowerCase().startsWith("zh") && CJK_RE.test(text)) {
      out[index] = text;
      return;
    }
    const known = slots.get(text);
    if (known) {
      known.push(index);
      return;
    }
    slots.set(text, [index]);
    unique.push(text);
  });

  const now = Date.now();
  const candidates: string[] = [];
  for (const text of unique) {
    const key = cacheKey(text, target);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      for (const index of slots.get(text) ?? []) out[index] = hit.t;
      continue;
    }
    // 当前所有可用接口都在负缓存里就别再问了
    if (providerOrder().every((provider) => negativeHit(provider, key))) continue;
    candidates.push(text);
  }
  if (candidates.length === 0) return out;

  const values = new Map<string, string>();
  const order = providerOrder();
  for (const provider of order) {
    const remaining = candidates.filter((text) => !values.has(text) && !negativeHit(provider, cacheKey(text, target)));
    if (remaining.length === 0) continue;
    try {
      await callProvider(provider, remaining, target, (index, value) => values.set(remaining[index], value));
    } catch (err) {
      // 这个接口这次用不了：剩下的文本给它记一笔负缓存，立刻换下一个
      for (const text of remaining) markNegative(provider, cacheKey(text, target));
      const status = statusOf(err);
      if (provider === "deepl") {
        if (status === 401 || status === 403) {
          deeplDisabled = true;
          log.warn("DeepL 翻译 Key 无效，本次已停用并降级");
        } else if (status === 456) {
          deeplDisabled = true;
          log.warn("DeepL 翻译额度用尽，本次已停用并降级");
        } else {
          log.warn(`DeepL 翻译失败（${reasonOf(err)}），改用下一个接口`);
        }
      } else if (provider === preferred) {
        // uapis / suapi 里的首选挂了：立刻切到另一个，并保持 10 分钟不再优先选它
        switchPreferenceTo(provider === "uapis" ? "suapi" : "uapis", reasonOf(err));
      } else {
        log.warn(`备用接口 ${PROVIDER_LABEL[provider]} 也失败（${reasonOf(err)}），本批翻译留空`);
      }
    }
  }

  let changed = false;
  for (const text of candidates) {
    const value = values.get(text);
    if (value === undefined) continue;
    cache.set(cacheKey(text, target), { t: value, at: Date.now() });
    for (const index of slots.get(text) ?? []) out[index] = value;
    changed = true;
  }
  if (changed) void persist();
  return out;
}

/** 单条翻译：走同一套缓存/主备逻辑，失败返回 undefined（调用方显示原文）。 */
export async function translateText(text: string, toLang: string): Promise<string | undefined> {
  const [value] = await translateBatch([text], toLang);
  return value;
}

// ---------- 长文（详情正文）分段翻译 ----------
// 详情正文几千到几万字符，一条请求吃不下（接口上限 3000）：按空行切段落，逐段判定
// 「能不能翻」，逐段回填——任一段失败只保留那一段原文，绝不整篇回退或抛错。

/** 单块目标长度：接口上限 3000，留余量给前后缀。 */
const BODY_BLOCK_CHARS = 1800;
/** 正文最多翻多少块（约 2 万字符）：再多只会把详情页拖死，剩下的保留原文。 */
const BODY_MAX_BLOCKS = 12;
/** 正文整体预算：到点就带着已翻部分返回，剩下的保留原文（详情页不能无限等）。 */
const BODY_BUDGET_MS = 20_000;

/** 正文翻译结果：text 是可以直接展示的（部分）译文，其余字段用于自检/日志。 */
export interface BodyTranslation {
  text: string;
  /** 识别出的可翻块数。 */
  blocks: number;
  /** 成功翻出的块数。 */
  translated: number;
  /** 翻失败（保留原文）的块数。 */
  failed: number;
  /** 因超出块数上限而没翻的块数。 */
  overLimit: number;
  /** 按规则整块跳过（代码块/纯链接/分隔线等）的块数。 */
  skipped: number;
  /** 预算/条数用尽：还有块没翻完。 */
  pending: boolean;
  elapsedMs: number;
}

/** 段落里出现围栏行（``` / ~~~）就当成代码块处理。 */
const FENCE_LINE = /^\s*(?:```|~~~)/gm;

/** 整块跳过：空块、代码块、纯链接/图片行、纯 URL、分隔线、没有自然语言的块。 */
function skippableBodyBlock(block: string): boolean {
  const text = block.trim();
  if (!text) return true;
  // 纯链接行 / 纯图片行 / 纯 URL：翻了只会把目标地址翻坏
  if (/^!?\[[^\]]*\]\([^)]*\)$/.test(text)) return true;
  if (/^<?https?:\/\/\S+>?$/i.test(text)) return true;
  // 分隔线、表格对齐行
  if (/^[-=_*\s|:]+$/.test(text)) return true;
  // 英文单词都没有（纯数字/符号/中文）：没必要翻
  if (!/[A-Za-z]{2}/.test(text)) return true;
  return false;
}

/** 拆出「缩进 + Markdown 标记 / 正文 / 尾部空白」，译文只替换正文，标记原样保留。 */
function splitBodyBlock(block: string): { prefix: string; core: string; tail: string } {
  const lead = /^\s*/.exec(block)?.[0] ?? "";
  const rest0 = block.slice(lead.length);
  const mark = /^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/.exec(rest0)?.[0] ?? "";
  const rest = rest0.slice(mark.length);
  const trail = /\s*$/.exec(rest)?.[0] ?? "";
  return { prefix: lead + mark, core: rest.slice(0, rest.length - trail.length), tail: trail };
}

/** 超长段落按句末切开，切点找不到就退回空格，最后才硬切。 */
function splitLongText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const at = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
      window.lastIndexOf("; "),
    );
    const cut = at > limit * 0.4 ? at + 1 : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * 长文（Markdown 正文）分段翻译：逐段判定 → 逐段回填，块数/时间双上限。
 * 只翻自然语言段落，代码块、纯链接、分隔线整块保留原文；任何一段失败都只影响它自己。
 */
export async function translateMarkdownBody(
  body: string,
  toLang = "zh-CN",
  options: { maxBlocks?: number; budgetMs?: number } = {},
): Promise<BodyTranslation> {
  const started = Date.now();
  const target = String(toLang ?? "").trim() || "zh-CN";
  const maxBlocks = Math.max(1, options.maxBlocks ?? BODY_MAX_BLOCKS);
  const budget = Math.max(0, options.budgetMs ?? BODY_BUDGET_MS);
  const source = String(body ?? "");

  /** 一块待回填的段落：pieces 是它拆出来的请求片段，zh 是已拿到的译文（缺省=保留原文）。 */
  interface Unit {
    token: number;
    prefix: string;
    tail: string;
    pieces: { text: string; zh?: string }[];
  }

  const tokens = source.split(/(\n\s*\n)/);
  const units: Unit[] = [];
  const queue: string[] = [];
  let skipped = 0;
  let overLimit = 0;
  let inFence = false;

  for (let token = 0; token < tokens.length; token += 2) {
    const raw = tokens[token] ?? "";
    if (!raw.trim()) {
      skipped += 1;
      continue;
    }
    const marks = (raw.match(FENCE_LINE) ?? []).length;
    if (inFence) {
      skipped += 1;
      if (marks % 2 === 1) inFence = false;
      continue;
    }
    if (marks > 0) {
      skipped += 1;
      if (marks % 2 === 1) inFence = true;
      continue;
    }
    if (skippableBodyBlock(raw)) {
      skipped += 1;
      continue;
    }
    const { prefix, core, tail } = splitBodyBlock(raw);
    if (!core.trim()) {
      skipped += 1;
      continue;
    }
    if (units.length >= maxBlocks) {
      overLimit += 1;
      continue;
    }
    const unit: Unit = { token, prefix, tail, pieces: splitLongText(core, BODY_BLOCK_CHARS).map((text) => ({ text })) };
    for (const piece of unit.pieces) {
      // 片段本身是中文（混排正文）就别浪费额度
      if (containsCjk(piece.text)) piece.zh = piece.text;
      else queue.push(piece.text);
    }
    units.push(unit);
  }

  // 一段一请求：接口对某段报错/限流时，只有那段的负缓存被记上，其它段照常翻。
  // （整批一起发更快，但一批里有一个坏段落会让同批全挂，正文就整段回退了。）
  let pending = false;
  const wanted = units.flatMap((unit) => unit.pieces.filter((piece) => piece.zh === undefined));
  for (const piece of wanted) {
    if (Date.now() - started >= budget) {
      pending = true;
      break;
    }
    try {
      const [value] = await translateBatch([piece.text], target);
      if (typeof value === "string" && value.trim() && value !== piece.text) piece.zh = value;
    } catch (err) {
      // 这一段保留原文，继续下一段
      log.warn(`正文分段翻译失败（保留原文）：${messageOf(err)}`);
    }
  }

  let translated = 0;
  let failed = 0;
  for (const unit of units) {
    for (const piece of unit.pieces) {
      if (piece.zh === undefined) failed += 1;
      else translated += 1;
    }
  }
  const out = tokens.slice();
  for (const unit of units) {
    // 整块没有任何译文就原样留着，避免拼出空的段落
    if (unit.pieces.every((piece) => piece.zh === undefined)) continue;
    out[unit.token] = unit.prefix + unit.pieces.map((piece) => piece.zh ?? piece.text).join("") + unit.tail;
  }

  return {
    text: out.join(""),
    blocks: units.length,
    translated,
    failed,
    overLimit,
    skipped,
    pending,
    elapsedMs: Date.now() - started,
  };
}

