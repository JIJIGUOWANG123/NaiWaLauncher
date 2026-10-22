const path = require("node:path");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const minekuai = require(path.join(dist, "mods", "minekuai"));

(async () => {
  initPaths(path.join(__dirname, ".."));
  await ensureDirs();
  await loadSettings();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return realFetch(...args); };
  minekuai.clearMinekuaiCache();
  const a = await minekuai.searchMinekuai("sodium", "1.21.4", "fabric", 20, 0);
  const afterFirst = calls;
  const b = await minekuai.searchMinekuai("sodium", "1.21.4", "fabric", 20, 0);
  const afterSecond = calls;
  console.log("[cache] first hits=" + a.length + " fetch=" + afterFirst + " | repeat hits=" + b.length + " fetch=" + afterSecond);
  const c = await minekuai.searchMinekuai("sodium", "1.21.4", "fabric", 10, 0);
  console.log("[cache] different limit -> fetch=" + calls + " (应增加 1 次，key 含 limit)");
  globalThis.fetch = realFetch;
  process.exit(0);
})().catch((e) => { console.log("[failed]", String(e && e.stack || e).slice(0, 600)); process.exit(1); });
