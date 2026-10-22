// 自检：整合包并行安装（Fabulously Optimized · 1KVo5zza）。
// 先删掉同名实例，再真实跑一遍一键安装，记录总耗时、成功/失败文件数与下载阶段的 n/total 进度序列。
// 用法：node scripts/modpack-parallel-check.js [并发数]
const path = require("node:path");
const fs = require("node:fs");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs, getPaths, instanceDir } = require(path.join(dist, "core", "paths"));
const { loadSettings, getSettings, updateSettings } = require(path.join(dist, "core", "settings"));
const { setEventSink } = require(path.join(dist, "core", "events"));
const { listInstances, deleteInstance } = require(path.join(dist, "minecraft", "instances"));
const { installModpack } = require(path.join(dist, "mods", "index"));

const PROJECT = "1KVo5zza";
const INSTANCE_HINT = "Fabulously Optimized";

const events = [];

function countFiles(dir, filter) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(full, filter);
      count += sub.count;
      bytes += sub.bytes;
    } else if (entry.isFile() && filter(entry.name)) {
      count += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { count, bytes };
}

/** 只保留 n/total 真正变化的那一帧，避免节流窗口内的重复帧淹没有效信息。 */
function sample(pick) {
  const out = [];
  let last = null;
  for (const event of events) {
    const value = pick(event);
    if (value === null) continue;
    if (value === last) continue;
    last = value;
    out.push(value);
  }
  return out;
}

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();

  const wanted = Number(process.argv[2] ?? "");
  const original = fs.readFileSync(getPaths().settingsFile, "utf8");
  if (Number.isFinite(wanted) && wanted > 0) await updateSettings({ concurrentDownloads: wanted });
  const settings = getSettings();
  console.log("[settings] concurrentDownloads=" + settings.concurrentDownloads + " connectionsPerFile=" + settings.connectionsPerFile);
  console.log("[settings] 原始 settings.json 会在结束时原样写回");

  const existing = (await listInstances()).filter((instance) => instance.name.includes(INSTANCE_HINT));
  for (const instance of existing) {
    await deleteInstance(instance.id);
    console.log("[cleanup] 已删除旧实例 " + instance.id + "（" + instance.name + "）");
  }

  setEventSink({
    progress(p) {
      events.push({ at: Date.now(), label: p.label, stage: p.stage, filesDone: p.filesDone, filesTotal: p.filesTotal, percent: p.percent });
    },
    done() {
      /* 结束事件不影响计时，忽略 */
    },
  });

  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await installModpack("modrinth", PROJECT);
  } catch (err) {
    error = err;
  }
  const seconds = (Date.now() - startedAt) / 1000;

  // 还原用户原来的设置文件
  fs.writeFileSync(getPaths().settingsFile, original);

  console.log("=== RESULT ===");
  console.log(JSON.stringify(result ?? { error: String(error && error.message ? error.message : error) }, null, 2));
  const phaseSeconds = (match) => {
    const hits = events.filter((event) => match(event.stage));
    if (hits.length < 2) return null;
    return (hits[hits.length - 1].at - hits[0].at) / 1000;
  };
  const downloadSeconds = phaseSeconds((stage) => stage.startsWith("下载整合包模组"));
  const overrideSeconds = phaseSeconds((stage) => stage.startsWith("解压 overrides"));
  console.log("[timing] 总耗时 " + seconds.toFixed(1) + "s" +
    " · 模组下载阶段 " + (downloadSeconds === null ? "?" : downloadSeconds.toFixed(1) + "s") +
    " · overrides 阶段 " + (overrideSeconds === null ? "?" : overrideSeconds.toFixed(1) + "s"));

  if (result) {
    console.log("[stats] 文件成功 " + result.filesDownloaded + " / 总数 " + result.filesTotal + " / 失败 " + result.filesFailed.length +
      " / 拒绝 " + result.filesRejected + " · overrides 写入 " + result.overridesWritten);
    const gameDir = instanceDir(result.instanceId);
    const all = countFiles(gameDir, () => true);
    const jars = countFiles(path.join(gameDir, "mods"), (name) => /\.jar$/i.test(name));
    console.log("[disk] 实例目录 " + all.count + " 个文件 " + (all.bytes / 1048576).toFixed(1) + "MB · mods 里 " + jars.count + " 个 jar");
  }

  const downloadSeq = sample((event) => (event.stage.startsWith("下载整合包模组") ? event.filesDone + "/" + event.filesTotal : null));
  console.log("[progress] 下载阶段 n/total 序列（" + downloadSeq.length + " 帧）：");
  console.log("  " + downloadSeq.join(" → "));
  const overrideSeq = sample((event) => (event.stage.startsWith("解压 overrides") ? event.stage.replace("解压 overrides ", "") : null));
  console.log("[progress] overrides 阶段 n/total 序列（" + overrideSeq.length + " 帧）：");
  console.log("  " + overrideSeq.join(" → "));
  const stages = [];
  for (const event of events) {
    const key = event.label + " › " + event.stage;
    if (stages[stages.length - 1] !== key) stages.push(key);
  }
  console.log("[progress] 阶段轨迹（" + stages.length + " 段）：");
  for (const stage of stages.slice(0, 40)) console.log("  " + stage);
  process.exit(result && result.filesFailed.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error("CHECK FAILED: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
