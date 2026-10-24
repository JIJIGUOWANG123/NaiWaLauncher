// 翻译自检：DeepL（最高优先）/ uapis 主备切换 / suapi 批量 / 负缓存 / 中文搜索
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const { initPaths } = require("../dist-electron/main/core/paths.js");
initPaths(ROOT);

const translate = require("../dist-electron/main/mods/translate.js");
const settingsMod = require("../dist-electron/main/core/settings.js");
const mods = require("../dist-electron/main/mods/index.js");

const cacheFile = path.join(ROOT, "NaiWa", "meta", "translate-cache.json");
/** 运行时可改的设置覆盖层：各步骤用它切 deeplApiKey。 */
let settingsOverride = {};
const baseGetSettings = settingsMod.getSettings;
settingsMod.getSettings = () => ({ ...baseGetSettings(), ...settingsOverride });
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (v, n = 60) => (v === undefined ? "<undefined>" : JSON.stringify(String(v).slice(0, n)));
const ok = (cond, label) => console.log(`[${cond ? "PASS" : "FAIL"}] ${label}`);
const SEARCH_CN = { query: "钠", provider: "modrinth", gameVersion: "1.21.4", loader: "fabric" };
const RAW = (q) => ({ query: q, provider: "modrinth", gameVersion: "1.21.4", loader: "fabric" });

async function fresh() {
  translate.clearTranslateCache();
  mods.clearDetailCache();
  await sleep(300);
  translate.clearTranslateCache();
  if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile, { force: true });
  await sleep(100);
  translate.clearTranslateCache();
}

function stubFetch(handlers) {
  globalThis.fetch = async (url, init) => {
    const text = String(url);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (text.includes(needle)) return handler(text, init);
    }
    return realFetch(url, init);
  };
}

async function rawTitles(query) {
  const settingsModGet = settingsMod.getSettings;
  settingsMod.getSettings = () => ({ ...settingsModGet(), translateMods: false, translateSearch: false });
  const results = await mods.searchMods(RAW(query));
  settingsMod.getSettings = settingsModGet;
  return { results, titles: results.map((m) => m.title).filter((t) => !/[\u4e00-\u9fff]/.test(t)).slice(0, 20) };
}

(async () => {
  let before = 0;
  let started = 0;
  console.log("===== D1) DeepL：冷缓存单条 =====");
  await fresh();
  settingsOverride = {};
  console.log(`  尝试顺序 = ${translate.getProviderOrder().join(" → ")}`);
  before = translate.translateRequestCount();
  started = Date.now();
  const deeplSingle = await translate.translateText("Sodium", "zh-CN");
  console.log(`  translateText("Sodium","zh-CN") = ${clip(deeplSingle)} · ${Date.now() - started}ms · HTTP ${translate.translateRequestCount() - before} 次 · provider = ${translate.getProviderOrder()[0]}`);
  ok(deeplSingle === "钠" && translate.getProviderOrder()[0] === "deepl", "DeepL 优先翻译出 钠");
  ok(translate.translateRequestCount() - before === 1, "只用了 1 个 HTTP 请求");

  console.log("===== D2) DeepL：批量 20 条标题一次请求 =====");
  await fresh();
  // 凑满 20 条英文标题（Sodium 一页里有两三条本身是中文，会被跳过）
  const pool = [...(await rawTitles("Sodium")).titles, ...(await rawTitles("Iris")).titles];
  const deeplTitles = [...new Set(pool)].slice(0, 20);
  before = translate.translateRequestCount();
  started = Date.now();
  const deeplBatch = await translate.translateBatch(deeplTitles, "zh-CN");
  const deeplRequests = translate.translateRequestCount() - before;
  console.log(`  ${deeplTitles.length} 条 → HTTP ${deeplRequests} 次 · 耗时 ${Date.now() - started}ms · 成功 ${deeplBatch.filter(Boolean).length}/${deeplTitles.length}`);
  console.log(`  前 3 条：${deeplTitles.slice(0, 3).map((t, i) => t + " → " + clip(deeplBatch[i], 14)).join(" | ")}`);
  ok(deeplRequests === 1, `批量只用 1 个 HTTP 请求（实际 ${deeplRequests}）`);
  ok(deeplBatch.filter(Boolean).length >= deeplTitles.length - 1, "20 条基本全部翻出");

  console.log("===== D3) DeepL：中文搜索 =====");
  await fresh();
  const rawTranslateForQuery = translate.translateText;
  let deeplQuery = "";
  translate.translateText = async (text, toLang) => {
    const out = await rawTranslateForQuery(text, toLang);
    if (toLang === "en") deeplQuery = out || "(失败)";
    return out;
  };
  before = translate.translateRequestCount();
  started = Date.now();
  const deeplSearch = await mods.searchMods(SEARCH_CN);
  translate.translateText = rawTranslateForQuery;
  console.log(`  译后 query = ${clip(deeplQuery)} · 结果 ${deeplSearch.length} 条 · ${Date.now() - started}ms · HTTP 请求 ${translate.translateRequestCount() - before} 次`);
  deeplSearch.slice(0, 3).forEach((m) => console.log(`  - ${m.title} | titleZh=${clip(m.titleZh, 20)}`));
  ok(deeplQuery && deeplQuery.toLowerCase().includes("sodium"), "中文 query 已译为英文");
  ok(deeplSearch.length > 0 && deeplSearch.slice(0, 3).every((m) => m.titleZh), "前 3 条都有 titleZh");

  console.log("===== D4) 清空 deeplApiKey → 回退 uapis/suapi =====");
  await fresh();
  settingsOverride = { deeplApiKey: "" };
  console.log(`  尝试顺序 = ${translate.getProviderOrder().join(" → ")}`);
  before = translate.translateRequestCount();
  const fallback = await translate.translateText("Sodium", "zh-CN");
  console.log(`  结果 = ${clip(fallback)} · HTTP ${translate.translateRequestCount() - before} 次 · 首选 = ${translate.getPreferredProvider()}`);
  ok(translate.getProviderOrder()[0] === "uapis", "空 Key 时不再尝试 DeepL（顺序从 uapis 开始）");
  ok(fallback === "钠", "回退后仍翻出 钠");
  settingsOverride = {};

  console.log("===== D5) 假 Key（x:fx）→ 401 降级，且之后不再尝试 =====");
  await fresh();
  settingsOverride = { deeplApiKey: "x:fx" };
  let deeplHits = 0;
  stubFetch({ "deepl.com": async (u, i) => { deeplHits += 1; return realFetch(u, i); } });
  const fakeKeyFirst = await translate.translateText("Sodium", "zh-CN");
  const deeplAfterFirst = deeplHits;
  const fakeKeySecond = await translate.translateText("Lithium", "zh-CN");
  globalThis.fetch = realFetch;
  console.log(`  首次 = ${clip(fakeKeyFirst)} · 第二次 = ${clip(fakeKeySecond)} · DeepL 请求 ${deeplHits} 次（首次 ${deeplAfterFirst} 次）· 顺序 = ${translate.getProviderOrder().join(" → ")}`);
  ok(deeplAfterFirst === 1, "假 Key 只打了一次 DeepL（真 401）");
  ok(deeplHits === deeplAfterFirst, "之后不再尝试 DeepL");
  ok(!translate.getProviderOrder().includes("deepl"), "DeepL 已从尝试顺序里移除（本进程停用）");
  ok(!!fakeKeyFirst && !!fakeKeySecond, "降级后由 uapis/suapi 接住");
  settingsOverride = {};

  console.log("===== 1) 真实：单条翻译（uapis 主，DeepL 已在本进程停用）=====");
  await fresh();
  translate.setPreferredProvider("uapis");
  before = translate.translateRequestCount();
  started = Date.now();
  const single = await translate.translateText("Sodium", "zh-CN");
  console.log(`  translateText("Sodium","zh-CN") = ${clip(single)} · ${Date.now() - started}ms · HTTP ${translate.translateRequestCount() - before} 次 · 当前首选 = ${translate.getPreferredProvider()}`);
  ok(single === "钠", "单条返回 钠");

  console.log("===== 2) 真实：suapi 批量一次翻 20 条标题 =====");
  await fresh();
  const { titles } = await rawTitles("Sodium");
  translate.setPreferredProvider("suapi");
  before = translate.translateRequestCount();
  started = Date.now();
  const batch = await translate.translateBatch(titles, "zh-CN");
  const batchRequests = translate.translateRequestCount() - before;
  const batchOk = batch.filter((v) => typeof v === "string" && v.trim()).length;
  console.log(`  ${titles.length} 条标题 → HTTP ${batchRequests} 次 · 总耗时 ${Date.now() - started}ms · 成功 ${batchOk}/${titles.length}`);
  console.log(`  前 3 条：${titles.slice(0, 3).map((t, i) => t + " → " + clip(batch[i], 16)).join(" | ")}`);
  ok(batchRequests === 1, `批量只用 1 个 HTTP 请求（实际 ${batchRequests}）`);
  ok(batchOk >= Math.min(20, titles.length) - 1, "20 条基本全部翻出");

  console.log("===== 3) 真实：主接口 429 → 自动切 suapi.net + 10 分钟粘滞 =====");
  await fresh();
  translate.setPreferredProvider("uapis");
  let uapisHits = 0;
  stubFetch({
    "uapis.cn": async () => { uapisHits += 1; return { ok: false, status: 429, text: async () => "" }; },
  });
  const failQuery = "Lithium";
  started = Date.now();
  const failed = await mods.searchMods(RAW(failQuery));
  const switchedTitle = failed.find((m) => m.titleZh);
  console.log(`  切换后搜索：${failed.length} 条 · ${Date.now() - started}ms · uapis 命中 ${uapisHits} 次 · 译名样例 = ${clip(switchedTitle && switchedTitle.titleZh, 20)} · 当前首选 = ${translate.getPreferredProvider()}`);
  ok(uapisHits === 1, "uapis 只撞了 1 次就切走");
  ok(translate.getPreferredProvider() === "suapi", "preferred 已切到 suapi");
  ok(failed.some((m) => m.titleZh), "切到 suapi 后译名正常返回");
  const hitsAfterFirst = uapisHits;
  const beforeSticky = translate.translateRequestCount();
  await mods.searchMods(RAW("Sodium Extra"));
  await mods.searchMods(RAW("Iris"));
  console.log(`  连续两次搜索：uapis 新增命中 ${uapisHits - hitsAfterFirst} 次 · HTTP 请求 ${translate.translateRequestCount() - beforeSticky} 次`);
  ok(uapisHits === hitsAfterFirst, "10 分钟粘滞期间不再碰 uapis");

  console.log("===== 3b) 10 分钟到期后允许回切主接口 =====");
  await fresh();
  translate.setPreferredProvider("suapi");
  let uapisBack = 0;
  let suapiStill = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  stubFetch({
    "uapis.cn": async () => { uapisBack += 1; return { ok: true, status: 200, json: async () => ({ translate: "钠" }) }; },
    "suapi.net": async () => { suapiStill += 1; return { ok: false, status: 500, text: async () => "" }; },
  });
  const back = await translate.translateBatch(["sticky-probe-" + realNow()], "zh-CN");
  Date.now = realNow;
  globalThis.fetch = realFetch;
  console.log(`  快进 11 分钟后：uapis 命中 ${uapisBack} 次 · suapi 命中 ${suapiStill} 次 · 首选 = ${translate.getPreferredProvider()} · 结果 = ${clip(back[0], 10)}`);
  ok(uapisBack === 1 && suapiStill === 0, "粘滞到期后自动回切到主接口");

  console.log("===== 4) 打桩：主接口健康时逐条 + 150ms 间隔 =====");
  await fresh();
  translate.setPreferredProvider("uapis");
  const { titles: titles2 } = await rawTitles("Sodium Extra");
  let suapiHits = 0;
  const stamps = [];
  stubFetch({
    "uapis.cn": async (_u, init) => {
      stamps.push(Date.now());
      const payload = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ text: payload.text, translate: "译:" + payload.text }) };
    },
    "suapi.net": async () => { suapiHits += 1; return { ok: false, status: 500, text: async () => "" }; },
  });
  before = translate.translateRequestCount();
  const serial = await translate.translateBatch(titles2, "zh-CN");
  const serialRequests = translate.translateRequestCount() - before;
  globalThis.fetch = realFetch;
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  console.log(`  ${titles2.length} 条 → uapis 请求 ${serialRequests} 次 · suapi 命中 ${suapiHits} 次 · 最小间隔 ${gaps.length ? Math.min(...gaps) : "-"}ms · 成功 ${serial.filter(Boolean).length} 条`);
  ok(serialRequests === titles2.length && suapiHits === 0, "主接口健康时不碰备用接口，逐条发送");
  ok(gaps.length > 0 && Math.min(...gaps) >= 140, `相邻请求 ≥150ms（实测最小 ${gaps.length ? Math.min(...gaps) : "-"}ms）`);

  console.log("===== 5) 真实：中文搜索 =====");
  await fresh();
  translate.setPreferredProvider("uapis");
  const originalGetSettings = settingsMod.getSettings;
  let translatedQuery = "";
  const rawTranslate = translate.translateText;
  translate.translateText = async (text, toLang) => {
    const out = await rawTranslate(text, toLang);
    if (toLang === "en") translatedQuery = out || "(失败)";
    return out;
  };
  before = translate.translateRequestCount();
  started = Date.now();
  const cn = await mods.searchMods(SEARCH_CN);
  const cnRequests = translate.translateRequestCount() - before;
  translate.translateText = rawTranslate;
  settingsMod.getSettings = originalGetSettings;
  console.log(`  译后 query = ${clip(translatedQuery)} · 结果 ${cn.length} 条 · ${Date.now() - started}ms · HTTP 请求 ${cnRequests} 次 · 首选 = ${translate.getPreferredProvider()}`);
  cn.slice(0, 3).forEach((m) => console.log(`  - ${m.title} | titleZh=${clip(m.titleZh, 20)}`));
  ok(cn.length > 0 && translatedQuery.toLowerCase() === "sodium", `query 已译为英文（${clip(translatedQuery)}）`);
  ok(cn.slice(0, 3).every((m) => m.titleZh), "前 3 条都有 titleZh");

  console.log("===== 6) 真实：紧接着重搜（负缓存 + 正缓存）=====");
  before = translate.translateRequestCount();
  const again = await mods.searchMods(SEARCH_CN);
  console.log(`  重搜：结果 ${again.length} 条 · HTTP 请求 ${translate.translateRequestCount() - before} 次 · 负缓存 ${translate.translateNegativeCount()} 条`);
  ok(translate.translateRequestCount() - before === 0, "重搜 0 请求");
  ok(again.filter((m) => m.titleZh).length === cn.filter((m) => m.titleZh).length, "重搜译名条数不变");

  console.log("===== 7) 磁盘缓存 =====");
  await sleep(700);
  const disk = fs.existsSync(cacheFile) ? Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8"))) : [];
  const sample = {};
  for (const [k, v] of disk.slice(0, 2)) sample[k.slice(0, 22) + "…"] = { t: String(v.t).slice(0, 24), at: v.at };
  console.log(`  条目数 = ${disk.length} · 片段 = ${JSON.stringify(sample)}`);
  console.log("===== 8) 真实：详情摘要 summaryZh =====");
  mods.clearDetailCache();
  started = Date.now();
  before = translate.translateRequestCount();
  const detail = await mods.getModDetail("modrinth", "sodium");
  console.log(`  summary=${clip(detail.summary, 40)}`);
  console.log(`  summaryZh=${clip(detail.summaryZh, 40)} · translated=${detail.translated} · bodyZh=${clip(detail.bodyZh, 10)} · ${Date.now() - started}ms · HTTP ${translate.translateRequestCount() - before} 次`);
  // 0.4.2 起正文也会翻（bodyZh），旧断言 !detail.bodyZh 已过期：只要求摘要翻译到位且标记 translated。
  ok(!!detail.summaryZh && detail.translated === true, "详情写 summaryZh 且 translated=true");

  console.log("===== 9) 真实：translateMods=false → 0 请求 =====");
  const originalGet = settingsMod.getSettings;
  settingsMod.getSettings = () => ({ ...originalGet(), translateMods: false });
  before = translate.translateRequestCount();
  const offResults = await mods.searchMods(SEARCH_CN);
  settingsMod.getSettings = originalGet;
  console.log(`  结果 ${offResults.length} 条 · HTTP 请求 ${translate.translateRequestCount() - before} 次 · 带 titleZh ${offResults.filter((m) => m.titleZh).length} 条`);
  ok(translate.translateRequestCount() - before === 0, "translateMods=false 时 0 请求");

  if (disk.some(([, v]) => String(v.t).startsWith("译:"))) {
    fs.rmSync(cacheFile, { force: true });
    console.log("  [info] 打桩产生的假译文已清理");
  }

  console.log("[info] 当前提供方：DeepL（有 Key 时最高优先）→ uapis.cn → suapi.net；Azure 已移除");
})().catch((err) => {
  console.log("[FATAL]", err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
