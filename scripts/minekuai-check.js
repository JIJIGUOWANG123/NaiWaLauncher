const path = require("node:path");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const instances = require(path.join(dist, "minecraft", "instances"));
const mods = require(path.join(dist, "mods", "index"));
const minekuai = require(path.join(dist, "mods", "minekuai"));

const short = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);

(async () => {
  initPaths(path.join(__dirname, ".."));
  await ensureDirs();
  const settings = await loadSettings();
  console.log("[settings] translateSearch=" + settings.translateSearch + " translateMods=" + settings.translateMods + " modProvider=" + settings.modProvider);

  // 1) 英文关键词 + 版本/加载器过滤
  const a = await mods.searchMods({ provider: "minekuai", query: "sodium", gameVersion: "1.21.4", loader: "fabric" });
  console.log("[1] search sodium/1.21.4/fabric hits=" + a.length);
  for (const m of a.slice(0, 3)) {
    console.log("  - " + m.projectId + " | slug=" + m.slug + " | title=" + m.title + " | titleZh=" + JSON.stringify(m.titleZh || "") +
      " | summaryZh=" + JSON.stringify(short(m.summaryZh, 40)) + " | dl=" + m.downloads + " | cats=" + m.categories.join("/"));
  }

  // 2) 中文关键词（验证服务端中文检索是否直达，不经过翻译）
  const b = await mods.searchMods({ provider: "minekuai", query: "钠" });
  console.log("[2] search 钠 hits=" + b.length);
  for (const m of b.slice(0, 3)) {
    console.log("  - " + m.slug + " | title=" + m.title + " | titleZh=" + JSON.stringify(m.titleZh || "") +
      " | summaryZh=" + JSON.stringify(short(m.summaryZh, 50)));
  }

  // 2b) 缓存命中：同样参数再查一次不应产生新请求（打印条目是否一致）
  const b2 = await mods.searchMods({ provider: "minekuai", query: "钠" });
  console.log("[2b] cached repeat hits=" + b2.length + " identicalProjectIds=" + (JSON.stringify(b.map(m => m.projectId)) === JSON.stringify(b2.map(m => m.projectId))));

  // 3) 文件列表：minekuai → modrinth
  const files = await mods.listModFiles({ provider: "minekuai", projectId: "AANobbMI", gameVersion: "1.21.4", loader: "fabric" });
  console.log("[3] files hits=" + files.length);
  for (const f of files.slice(0, 2)) {
    console.log("  - " + f.fileName + " | provider=" + f.provider + " | exact=" + f.exactMatch + " | " + f.gameVersions.join("/") + " | " + f.loaders.join("/"));
  }

  // 4) 真装一个文件
  const all = await instances.listInstances();
  console.log("[4] instances=" + all.map((i) => i.id + "(" + i.mcVersion + "/" + i.loader + ")").join(", "));
  const pick = all.find((i) => String(i.mcVersion).startsWith("1.21") && i.loader === "fabric") || all.find((i) => i.loader === "fabric") || all[0];
  if (!pick) { console.log("[4] 没有实例，跳过安装"); process.exit(0); }
  console.log("[4] instance=" + pick.id + " mc=" + pick.mcVersion + " loader=" + pick.loader);
  const installed = await mods.installMod({ provider: "minekuai", projectId: "AANobbMI", instanceId: pick.id });
  console.log("[4] installed fileName=" + installed.fileName + " bytes=" + installed.sizeBytes + " path=" + installed.path);
  const onDisk = await mods.listInstalledMods(pick.id);
  const rec = onDisk.find((m) => m.fileName === installed.fileName);
  console.log("[4] onDisk=" + (rec ? rec.fileName + " (" + rec.sizeBytes + " bytes)" : "未找到"));
  process.exit(0);
})().catch((e) => { console.log("[failed]", String(e && e.stack || e).slice(0, 800)); process.exit(1); });
