const path = require("node:path");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings, getSettings } = require(path.join(dist, "core", "settings"));
const mods = require(path.join(dist, "mods", "index"));

(async () => {
  initPaths(path.join(__dirname, ".."));
  await ensureDirs();
  const s = await loadSettings();
  const k = s.curseforgeApiKey || "";
  console.log("[settings] provider=" + s.modProvider + " source=" + s.downloadSource + " key=" + k.slice(0, 4) + "…" + k.slice(-4) + " len=" + k.length);
  try {
    const r = await mods.searchMods({ provider: "curseforge", query: "jei", gameVersion: "1.20.1", loader: "fabric", limit: 5 });
    console.log("[curseforge search] hits=" + r.length);
    for (const m of r.slice(0, 3)) console.log("  -", m.projectId, m.title, "|", m.author, "|", m.downloads);
  } catch (e) { console.log("[curseforge search FAILED]", String(e.message || e).slice(0, 300)); }
  try {
    const f = await mods.listModFiles({ provider: "curseforge", projectId: "238222", gameVersion: "1.20.1", loader: "fabric", limit: 6 });
    console.log("[curseforge files] hits=" + f.length);
    for (const x of f.slice(0, 3)) console.log("  -", x.fileName, "| exact=" + x.exactMatch, "|", x.gameVersions.join("/"), "|", x.loaders.join("/"));
  } catch (e) { console.log("[curseforge files FAILED]", String(e.message || e).slice(0, 300)); }
  process.exit(0);
})().catch((e) => { console.log("[failed]", String(e.stack || e).slice(0, 600)); process.exit(1); });
