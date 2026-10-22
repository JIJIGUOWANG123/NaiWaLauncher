// 自检：光影/资源包/整合包搜索 → 地图列表与版本兼容 → 真实落盘安装 → 地图安装错误 → 安装索引
const path = require("node:path");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const instances = require(path.join(dist, "minecraft", "instances"));
const mods = require(path.join(dist, "mods", "index"));
const install = require(path.join(dist, "mods", "install"));
const { readInstallMap } = require(path.join(dist, "mods", "dependencies"));

const INSTANCE_ID = "diaglaunch-ea9072";
const short = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
const fs = require("node:fs");

function stamp(tag, obj) { console.log("[" + tag + "] " + JSON.stringify(obj)); }

(async () => {
  initPaths(path.join(__dirname, ".."));
  await ensureDirs();
  const settings = await loadSettings();
  console.log("[settings] versionIsolation=" + settings.versionIsolation + " template=" + settings.modFileNameTemplate);

  // ---------- 1) 四类搜索 ----------
  const kinds = ["mod", "shader", "resourcepack", "modpack"];
  const picks = {};
  for (const kind of kinds) {
    const rows = await mods.searchMinekuaiByKind(kind, "", "1.21.4");
    console.log("=== search kind=" + kind + " hits=" + rows.length);
    for (const r of rows.slice(0, 2)) {
      console.log("  - projectId=" + r.projectId + " | title=" + short(r.title, 40) +
        " | titleZh=" + JSON.stringify(short(r.titleZh, 30)) +
        " | summaryZh=" + JSON.stringify(short(r.summaryZh, 40)) +
        " | downloads=" + r.downloads);
    }
    picks[kind] = rows[0];
  }

  // ---------- 2) 地图列表 ----------
  let entries = await mods.listMapEntries("", 1, INSTANCE_ID);
  console.log("=== maps page1 count=" + entries.length);
  entries.forEach((m, i) => {
    console.log("  " + String(i + 1).padStart(2) + ". id=" + m.id + " | " + short(m.title, 22) +
      " | versions=" + JSON.stringify(m.versions) + " | size=" + m.fileSize + " | cat=" + m.category +
      " | author=" + short(m.author, 10) + " | dl=" + JSON.stringify(m.downloadUrl) +
      " | compatible=" + JSON.stringify(m.compatible));
  });
  const withVersions = entries.filter((m) => m.versions.length > 0).slice(0, 3);
  console.log("--- 前 3 条带 supportedVersions 的地图（实例 " + INSTANCE_ID + " / 1.21.4）：");
  for (const m of withVersions) {
    console.log("  * " + short(m.title, 20) + " | versions=" + JSON.stringify(m.versions) + " | compatible=" + JSON.stringify(m.compatible));
  }
  // 1.21.5 → false；1.21.4 或 1.21（前缀）→ true
  const exact = entries.find((m) => m.versions.includes("1.21.5"));
  const prefix = entries.find((m) => m.versions.includes("1.21"));
  console.log("[compat] 1.21.5 地图 " + (exact ? short(exact.title, 18) + " compatible=" + JSON.stringify(exact.compatible) : "本页没有 1.21.5 地图"));
  console.log("[compat] 1.21（前缀匹配 1.21.4）地图 " + (prefix ? short(prefix.title, 18) + " compatible=" + JSON.stringify(prefix.compatible) : "本页没有 1.21 地图"));
  // 找一条明确写 1.21.4 的地图（翻页最多 5 页）
  let exact141 = null;
  for (let page = 1; page <= 5 && !exact141; page += 1) {
    const rows = page === 1 ? entries : await mods.listMapEntries("", page, INSTANCE_ID);
    exact141 = rows.find((m) => m.versions.includes("1.21.4")) || null;
  }
  console.log("[compat] 1.21.4 地图 " + (exact141 ? short(exact141.title, 18) + " versions=" + JSON.stringify(exact141.versions) + " compatible=" + JSON.stringify(exact141.compatible) : "未找到写 1.21.4 的地图"));
  console.log("[compat] 不带 instanceId 时 compatible=" + JSON.stringify((await mods.listMapEntries("", 1))[0].compatible));

  // ---------- 3) 真实安装：资源包 / 光影 / 整合包 ----------
  for (const kind of ["resourcepack", "shader", "modpack"]) {
    const pick = picks[kind];
    const result = await mods.installMod({ provider: "minekuai", projectId: pick.projectId, instanceId: INSTANCE_ID, kind });
    const onDisk = fs.statSync(result.path);
    const rel = path.relative(path.join(__dirname, ".."), result.path);
    console.log("=== install kind=" + kind + " project=" + pick.projectId + " (" + short(pick.title, 24) + ")");
    console.log("    fileName=" + result.fileName);
    console.log("    path=" + rel);
    console.log("    bytes=" + onDisk.size);
    console.log("    dirExists=" + fs.existsSync(path.dirname(result.path)) + " expectedDir=" + install.contentDirForInstance({ id: INSTANCE_ID }, kind));
  }

  // ---------- 4) 地图安装必须抛可读错误 ----------
  try {
    await mods.installMod({ provider: "minekuai", projectId: entries[0].id, instanceId: INSTANCE_ID, kind: "map" });
    console.log("[map] 未抛错（不符合预期）");
  } catch (err) {
    console.log("[map] threw: " + err.message);
  }

  // ---------- 5) 安装索引含 kind ----------
  const map = await readInstallMap();
  const rows = Object.entries(map[INSTANCE_ID] || {});
  console.log("=== install-map entries=" + rows.length);
  for (const [fileName, record] of rows) console.log("  - " + fileName + " → " + JSON.stringify(record));

  process.exit(0);
})().catch((e) => { console.log("[failed]", String((e && e.stack) || e).slice(0, 1200)); process.exit(1); });
