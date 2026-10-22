const path = require("node:path");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const instances = require(path.join(dist, "minecraft", "instances"));
const mods = require(path.join(dist, "mods", "index"));

(async () => {
  initPaths(path.join(__dirname, ".."));
  await ensureDirs();
  await loadSettings();
  const all = await instances.listInstances();
  const pick = all[0];

  // 依赖：minekuai → modrinth（iris 必需前置是 sodium）
  const deps = await mods.getModDependencies("minekuai", "YL57xq9U", pick.id, undefined);
  console.log("[deps] minekuai iris -> " + deps.length + " 条：" + deps.map((d) => d.projectId + "/" + (d.name || d.slug) + "/required=" + d.required + "/installed=" + d.installed).join(", "));

  // 详情：minekuai → modrinth
  const detail = require(path.join(dist, "mods", "detail"));
  const d = await detail.getModDetail("minekuai", "AANobbMI");
  console.log("[detail] provider=" + d.provider + " title=" + d.title + " author=" + d.author + " dl=" + d.downloads);

  // 错误文案：把 fetch 打成 503
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 503, statusText: "Service Unavailable" }); };
  try {
    await mods.searchMods({ provider: "minekuai", query: "trigger-error-" + Date.now() });
    console.log("[err] 竟然没抛错");
  } catch (e) {
    console.log("[err] " + String(e && e.message || e) + " (fetch 调用 " + calls + " 次)");
  } finally { globalThis.fetch = realFetch; }
  process.exit(0);
})().catch((e) => { console.log("[failed]", String(e && e.stack || e).slice(0, 800)); process.exit(1); });
