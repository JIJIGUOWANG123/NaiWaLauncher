// 自检：用 Fabulously Optimized（1KVo5zza）真实跑一遍一键安装，并统计落盘结果。
const path = require("node:path");
const fs = require("node:fs");
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs, getPaths, instanceDir } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const { setEventSink } = require(path.join(dist, "core", "events"));
const { getInstance } = require(path.join(dist, "minecraft", "instances"));
const { installModpack } = require(path.join(dist, "mods", "index"));

const PROJECT = "1KVo5zza";
const stages = new Set();
const doneEvents = [];

function countFiles(dir, filter) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full, filter);
    else if (entry.isFile() && filter(entry.name)) total += 1;
  }
  return total;
}

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();
  // 只录进度事件（label/stage），不打印每条，避免刷屏
  setEventSink({
    progress(p) {
      stages.add(p.label + " › " + p.stage);
    },
    done(r) {
      doneEvents.push({ label: r.label, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    },
  });

  const startedAt = Date.now();
  const result = await installModpack("modrinth", PROJECT);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  const meta = await getInstance(result.instanceId);
  console.log("[instance] " + JSON.stringify(meta));

  const gameDir = instanceDir(result.instanceId);
  const modCount = countFiles(path.join(gameDir, "mods"), (name) => /\.jar$/i.test(name));
  const rootFiles = countFiles(gameDir, () => true);
  const overrideDirs = ["config", "resourcepacks", "shaderpacks", "defaultconfigs"]
    .map((name) => name + "=" + (fs.existsSync(path.join(gameDir, name)) ? "有" : "无"))
    .join(" ");
  const topLevel = fs.readdirSync(gameDir).sort().join(" , ");
  const mrpack = path.join(getPaths().downloads, result.modpackFile);
  const mrpackSize = fs.existsSync(mrpack) ? fs.statSync(mrpack).size : -1;

  console.log("[evidence] mcVersion=" + meta.mcVersion + " loader=" + meta.loader + " loaderVersion=" + meta.loaderVersion +
    " versionId=" + meta.versionId);
  console.log("[evidence] files 总数=" + result.filesTotal + " 实际下载成功=" + result.filesDownloaded +
    " 被拒绝=" + result.filesRejected + " 失败=" + result.filesFailed.length);
  console.log("[evidence] instancе名称=" + result.name + " · mods 里 .jar 数量=" + modCount);
  console.log("[evidence] overridesWritten=" + result.overridesWritten + " 实例顶层目录=" + topLevel +
    " 实例内文件总数=" + rootFiles + " " + overrideDirs);
  console.log("[evidence] .mrpack=" + result.modpackFile + " 大小=" + mrpackSize + " 字节 · 耗时 " + seconds + "s");
  console.log("[evidence] 进度阶段样本（前 12 条）:");
  for (const stage of [...stages].slice(0, 12)) console.log("  - " + stage);
  console.log("[evidence] 任务完成事件: " + JSON.stringify(doneEvents.slice(-3)));
})().catch((err) => {
  console.error("自检失败：" + (err && err.stack ? err.stack : String(err)));
  process.exit(2);
});
