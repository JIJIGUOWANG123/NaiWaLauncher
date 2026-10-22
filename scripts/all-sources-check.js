// 自检：多来源搜索（source=all）/ 分类 / 筛选项，全程不依赖实例
const path = require("node:path");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const mods = require(path.join(dist, "mods", "index"));

const short = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);

function show(label, rows, n = 3) {
  console.log("=== " + label + " | total=" + rows.length);
  rows.slice(0, n).forEach((r, i) => {
    console.log("  " + (i + 1) + ". [" + r.provider + "] " + short(r.title, 42) +
      " | titleZh=" + JSON.stringify(short(r.titleZh, 24)) +
      " | summaryZh=" + (r.summaryZh ? "有" : "无") +
      " | dl=" + r.downloads + " | id=" + r.projectId);
  });
}

(async () => {
  initPaths(path.join(__dirname, ".."));
  await ensureDirs();
  const settings = await loadSettings();
  console.log("[settings] curseforgeApiKey=" + (settings.curseforgeApiKey ? "已填" : "空") +
    " translateMods=" + settings.translateMods + " translateSearch=" + settings.translateSearch);

  // ---------- 1) 资源包：所有来源 ----------
  const packs = await mods.searchMods({ source: "all", provider: "modrinth", query: "", kind: "resourcepack", gameVersion: "1.21.4" });
  show("resourcepack 所有来源 (1.21.4)", packs);
  const byProvider = packs.reduce((acc, r) => { acc[r.provider] = (acc[r.provider] || 0) + 1; return acc; }, {});
  console.log("[分布] " + JSON.stringify(byProvider) + " | 带 titleZh 的条数=" + packs.filter((r) => r.titleZh).length);
  const dupIds = packs.length - new Set(packs.map((r) => r.projectId)).size;
  console.log("[去重] 条数=" + packs.length + " 唯一 projectId=" + new Set(packs.map((r) => r.projectId)).size + " 重复=" + dupIds);
  console.log("[排序] downloads 降序=" + packs.every((r, i) => i === 0 || packs[i - 1].downloads >= r.downloads));
  // 各来源单独跑一遍，验证「先合并去重再截 40」而不是只取第一名来源
  const perSource = {};
  for (const src of ["modrinth", "minekuai"]) {
    perSource[src] = await mods.searchMods({ source: src, provider: src, query: "", kind: "resourcepack", gameVersion: "1.21.4", limit: 40 });
  }
  const rawIds = new Set();
  for (const rows of Object.values(perSource)) for (const r of rows) rawIds.add(r.projectId);
  const onlyKk = perSource.minekuai.filter((r) => !perSource.modrinth.some((m) => m.projectId === r.projectId));
  console.log("[来源] 各来源条数=" + JSON.stringify(Object.fromEntries(Object.entries(perSource).map(([k, v]) => [k, v.length]))) +
    " 去重后唯一 projectId=" + rawIds.size + " 合并后取前 " + packs.length +
    " | 麦块独有=" + onlyKk.length +
    " | 交集条数=" + (perSource.minekuai.length - onlyKk.length));
  const pairs = packs
    .map((r) => {
      const kkHit = perSource.minekuai.find((k) => k.projectId === r.projectId);
      const mdHit = perSource.modrinth.find((m) => m.projectId === r.projectId);
      return kkHit && mdHit ? { merged: r, kk: kkHit, md: mdHit } : null;
    })
    .filter(Boolean);
  const bigger = pairs.find((p) => p.kk.downloads > p.md.downloads) ?? pairs[0];
  console.log("[取大] 交集 " + pairs.length + " 条；样例 " + (bigger
    ? bigger.merged.projectId + " 合并后 dl=" + bigger.merged.downloads +
      " modrinth=" + bigger.md.downloads + " 麦块=" + bigger.kk.downloads +
      "（取大=" + (bigger.merged.downloads === Math.max(bigger.md.downloads, bigger.kk.downloads)) + "）" +
      " titleZh=" + JSON.stringify(bigger.merged.titleZh) + " 麦块 titleZh=" + JSON.stringify(bigger.kk.titleZh)
    : "无可比条目"));

  // ---------- 2) 模组 + 分类 optimization ----------
  const opt = await mods.searchMods({ source: "all", provider: "modrinth", query: "", kind: "mod", category: "optimization" });
  show("mod category=optimization", opt);
  console.log("[分类命中] 前 3 条的 categories：" + JSON.stringify(opt.slice(0, 3).map((r) => r.categories.filter((c) => c === "optimization"))));

  // ---------- 3) 资源包 + 分辨率 16x ----------
  const res16 = await mods.searchMods({ source: "all", provider: "modrinth", query: "", kind: "resourcepack", resolution: "16x" });
  console.log("=== resourcepack resolution=16x | total=" + res16.length);
  res16.slice(0, 3).forEach((r, i) => console.log("  " + (i + 1) + ". " + short(r.title, 40) + " [" + r.provider + "] cats=" + JSON.stringify(r.categories.slice(0, 6))));

  // ---------- 4) 分类列表 ----------
  const cats = await mods.listCategories("resourcepack", "all");
  console.log("=== listCategories(resourcepack, all) count=" + cats.length);
  cats.slice(0, 5).forEach((c, i) => console.log("  " + (i + 1) + ". id=" + c.id + " name=" + c.name + " count=" + JSON.stringify(c.count)));
  const catIds = new Set(cats.map((c) => c.id));
  console.log("[去重] 唯一 id=" + catIds.size + " / " + cats.length);
  const modCats = await mods.listCategories("mod", "modrinth");
  console.log("=== listCategories(mod, modrinth) count=" + modCats.length + " 前5=" + JSON.stringify(modCats.slice(0, 5).map((c) => c.id)));
  const kkCats = await mods.listCategories("mod", "minekuai");
  console.log("=== listCategories(mod, minekuai) count=" + kkCats.length + " 前5=" + JSON.stringify(kkCats.slice(0, 5).map((c) => c.id + ":" + c.count)));

  // ---------- 5) 筛选项 ----------
  for (const kind of ["mod", "resourcepack", "shader", "modpack"]) {
    const opts = await mods.listFilterOptions(kind);
    console.log("=== listFilterOptions(" + kind + ") versions=" + opts.versions.length +
      " 前5=" + JSON.stringify(opts.versions.slice(0, 5)) +
      " loaders=" + JSON.stringify(opts.loaders) +
      " resolutions=" + JSON.stringify(opts.resolutions));
  }

  // ---------- 6) 单来源回归 + 全部失败才抛错 ----------
  const single = await mods.searchMods({ source: "minekuai", provider: "minekuai", query: "钠", kind: "mod", limit: 5 });
  console.log("=== 单来源 minekuai query=钠 total=" + single.length + " 前3=" + JSON.stringify(single.slice(0, 3).map((r) => r.title)));
  const legacy = await mods.searchMods({ provider: "modrinth", query: "sodium", kind: "mod", limit: 3 });
  console.log("=== 不传 source（默认 all）query=sodium total=" + legacy.length + " providers=" + JSON.stringify([...new Set(legacy.map((r) => r.provider))]));
  console.log("[无实例] 以上全部调用都没有传 instanceId");

  // ---------- 7) 光影/资源包不把实例加载器当 facet（否则会被筛空） ----------
  const shaderWithLoader = await mods.searchMods({ source: "modrinth", provider: "modrinth", query: "", kind: "shader", loader: "fabric", limit: 5 });
  console.log("=== 光影 + 实例加载器 fabric：Modrinth 命中 " + shaderWithLoader.length + " 条（前3=" + JSON.stringify(shaderWithLoader.slice(0, 3).map((r) => r.title)) + "）");
  const modWithLoader = await mods.searchMods({ source: "modrinth", provider: "modrinth", query: "", kind: "mod", loader: "fabric", limit: 5 });
  console.log("=== 模组 + 加载器 fabric：Modrinth 命中 " + modWithLoader.length + " 条（facet 仍然生效）");
  try {
    await mods.searchMods({ source: "all", provider: "minekuai", query: "", kind: "map" });
    console.log("=== 地图走 all 竟然没抛错（不符合预期）");
  } catch (err) {
    console.log("=== 地图（kind=map）走 all 的报错=" + JSON.stringify(err.message));
  }

  // ---------- 8) 单来源失败降级 / 全部失败才抛错（就地替换 provider 的 search，不改设置） ----------
  const { modrinthProvider } = require(path.join(dist, "mods", "modrinth"));
  const { minekuaiProvider } = require(path.join(dist, "mods", "minekuai"));
  const realModrinth = modrinthProvider.search;
  const realMinekuai = minekuaiProvider.search;
  try {
    modrinthProvider.search = () => Promise.reject(new Error("模拟 Modrinth 故障"));
    const degraded = await mods.searchMods({ source: "all", provider: "modrinth", query: "", kind: "resourcepack", gameVersion: "1.21.4" });
    const dist3 = degraded.reduce((a, r) => { a[r.provider] = (a[r.provider] || 0) + 1; return a; }, {});
    console.log("=== [降级] Modrinth 故障时 total=" + degraded.length + " 来源分布=" + JSON.stringify(dist3) + "（未抛错）");
    minekuaiProvider.search = () => Promise.reject(new Error("模拟麦块故障"));
    try {
      await mods.searchMods({ source: "all", provider: "modrinth", query: "", kind: "resourcepack" });
      console.log("=== [全失败] 竟然没有抛错（不符合预期）");
    } catch (err) {
      console.log("=== [全失败] 抛错=" + JSON.stringify(err.message));
    }
  } finally {
    modrinthProvider.search = realModrinth;
    minekuaiProvider.search = realMinekuai;
  }
})().catch((err) => {
  console.error("[FAIL] " + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
