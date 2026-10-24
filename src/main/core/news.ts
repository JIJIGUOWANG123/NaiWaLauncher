// 关于页「最新新闻」：从 minecraft.net 官方文章网格接口取最新一篇，标题与摘要复用模组页那套翻译服务
// 译成中文（失败保留原文）。整条链路任何一步失败都返回 null：关于页整块不显示，也不弹错。
import type { NewsItem } from "../../shared/ipc";
import { logger } from "./logger";
import { systemFetch } from "./netfetch";
import { translateText } from "../mods/translate";

const log = logger("news");

const ORIGIN = "https://www.minecraft.net";
const HOME_URL = ORIGIN + "/en-us";
/** 首页会公布文章网格的 JSON 接口，路径随站点改版会变：每次先从首页现抠，抠不到才用这个兜底。 */
const GRID_FALLBACK =
  ORIGIN + "/content/minecraftnet/language-masters/en-us/jcr:content/root/container/image_grid_a_copy_64.articles.page-1.json";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NaiWaLauncher";
/** 成功结果缓存 30 分钟。 */
const TTL_MS = 30 * 60_000;
/** 失败只压 5 分钟：网络恢复后不用干等半小时。 */
const FAIL_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const CJK_RE = /[\u4e00-\u9fff]/;
/** 缩略图内联进 IPC 的上限：超过就退回远程地址，免得一次 invoke 塞进去几十兆。 */
const MAX_IMAGE_BYTES = 400 * 1024;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function absolute(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return ORIGIN + (url.startsWith("/") ? url : "/" + url);
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function request(url: string): Promise<string> {
  const res = await systemFetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

/** 首页把接口地址放在一段 HTML 转义的 JSON 里，先解回来再找路径。 */
function discoverGridUrl(html: string): string | undefined {
  const decoded = html.replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const match = decoded.match(/\/content\/minecraftnet\/[^"'\s\\]*articles\.page-1\.json/);
  return match ? ORIGIN + match[0] : undefined;
}

function readMeta(html: string, key: string): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = new RegExp('<meta[^>]+(?:property|name)="' + esc + '"[^>]*content="([^"]*)"', "i");
  const backward = new RegExp('<meta[^>]+content="([^"]*)"[^>]*(?:property|name)="' + esc + '"', "i");
  const hit = html.match(forward) ?? html.match(backward);
  return (hit?.[1] ?? "").trim();
}

/** 文章页只用来补发布时间与更完整的摘要/大图：拿不到就算了，不影响这条新闻本身。 */
async function readArticleMeta(url: string): Promise<{ summary?: string; image?: string; publishedAt?: string }> {
  try {
    const html = await request(url);
    const summary = readMeta(html, "og:description") || readMeta(html, "description");
    return {
      summary: summary || undefined,
      image: absolute(readMeta(html, "og:image")),
      publishedAt: readMeta(html, "article:published_time") || undefined,
    };
  } catch (err) {
    log.warn("文章页元数据读取失败（" + reasonOf(err) + "），改用列表摘要");
    return {};
  }
}

/**
 * 缩略图由主进程取好字节、以 data: URL 交给渲染层：渲染进程的 CSP 只放行 data:/file:/https:，
 * 但部分网络环境下渲染进程拉远程图会失败（主进程走的是系统网络栈），内联后界面稳定显示。
 */
async function inlineImage(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const res = await systemFetch(url, {
      headers: { "user-agent": USER_AGENT, referer: ORIGIN + "/" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return url;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return url;
    return "data:" + type.split(";")[0] + ";base64," + bytes.toString("base64");
  } catch (err) {
    log.warn("缩略图内联失败（" + reasonOf(err) + "），改用远程地址");
    return url;
  }
}

async function translateToZh(text: string): Promise<string> {
  if (!text || CJK_RE.test(text)) return text;
  try {
    const zh = (await translateText(text, "zh-CN"))?.trim();
    return zh || text;
  } catch (err) {
    log.warn("新闻翻译失败（" + reasonOf(err) + "），保留原文");
    return text;
  }
}

async function loadLatest(): Promise<NewsItem | null> {
  const home = await request(HOME_URL);
  const gridUrl = discoverGridUrl(home) ?? GRID_FALLBACK;
  const parsed = JSON.parse(await request(gridUrl)) as unknown;
  const tiles = asObject(parsed)?.article_grid;
  if (!Array.isArray(tiles) || tiles.length === 0) return null;
  // 网格按发布时间倒序排，第一条就是最新一篇。
  const first = asObject(tiles[0]);
  const tile = asObject(first?.default_tile) ?? first;
  const rawTitle = asText(tile?.title);
  const url = absolute(asText(first?.article_url));
  if (!rawTitle || !url) return null;
  const detail = await readArticleMeta(url);
  const rawSummary = asText(tile?.sub_header) || detail.summary || "";
  // 优先文章页的 og:image（大图，比例更适合卡片），退回列表里的方形小图
  const remoteImage = detail.image ?? absolute(asText(asObject(tile?.image)?.imageURL));
  return {
    title: await translateToZh(rawTitle),
    url,
    summary: rawSummary ? await translateToZh(rawSummary) : undefined,
    image: await inlineImage(remoteImage),
    publishedAt: detail.publishedAt,
  };
}

/** at = 写入时间，ttl = 这条结果该压多久（成功 30 分钟、失败 5 分钟）。 */
let cache: { at: number; ttl: number; item: NewsItem | null } | null = null;
/** 并发调用只发一次网络请求。 */
let inflight: Promise<NewsItem | null> | null = null;

/** 关于页的最新一篇新闻；拿不到就返回 null（调用方整块不显示）。force 只给自检用。 */
export async function getLatestNews(force = false): Promise<NewsItem | null> {
  if (!force && cache && Date.now() - cache.at < cache.ttl) return cache.item;
  if (inflight) return inflight;
  inflight = loadLatest()
    .then((item) => {
      cache = { at: Date.now(), ttl: item ? TTL_MS : FAIL_TTL_MS, item };
      if (item) log.info("最新新闻：" + item.title + " → " + item.url);
      else log.warn("minecraft.net 新闻列表里没解析出文章，关于页不显示该板块");
      return item;
    })
    .catch((err: unknown) => {
      // 静默降级：不抛给 IPC 调用方，关于页也不弹错。
      cache = { at: Date.now(), ttl: FAIL_TTL_MS, item: null };
      log.warn("minecraft.net 新闻抓取失败（" + reasonOf(err) + "），关于页不显示该板块");
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 自检用：清空进程内缓存（下次调用重新抓）。 */
export function clearNewsCache(): void {
  cache = null;
  inflight = null;
}
