// 自检：多文件并行下载提速。真实从 CDN 拉 N 个文件，分别用不同并发量跑 downloadMany，对比耗时与平均速度。
// 用法：node scripts/download-bench.js [files|small]   （默认两个 bench 都跑）
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings, getSettings } = require(path.join(dist, "core", "settings"));
const { resolveBase } = require(path.join(dist, "core", "sources"));
const { downloadMany } = require(path.join(dist, "core", "http"));

const CACHE = path.join(__dirname, ".download-bench-cache.json");
const MANIFEST = "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
const FILE_COUNT = 24;
const MB = 1048576;

/** 从若干正式版的依赖库里挑 jar：MAIN 取 ~2MB（部分走多分片、部分走 Small file），SMALL 取 <1MB（必定单连接）。 */
async function collect() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const manifest = await (await fetch(MANIFEST)).json();
  const releases = manifest.versions.filter((v) => v.type === "release").slice(0, 70);
  const main = new Map();
  const small = new Map();
  const offered = [];
  for (const version of releases) {
    let detail;
    try {
      detail = await (await fetch(version.url)).json();
    } catch {
      continue;
    }
    for (const lib of detail.libraries ?? []) {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.url || !artifact?.size) continue;
      offered.push(artifact.size);
      const item = { path: artifact.path, url: artifact.url, size: artifact.size, sha1: artifact.sha1 };
      if (artifact.size >= 1_700_000 && artifact.size <= 2_600_000 && !main.has(artifact.path)) main.set(artifact.path, item);
      if (artifact.size >= 300_000 && artifact.size <= 900_000 && !small.has(artifact.path)) small.set(artifact.path, item);
    }
  }
  // 取最大的 N 个：越接近 2MB 越能代表"整合包里的模组 jar"
  const pick = (map) => [...map.values()].sort((a, b) => b.size - a.size).slice(0, FILE_COUNT);
  const data = { main: pick(main), small: pick(small) };
  fs.writeFileSync(CACHE, JSON.stringify(data, null, 1));
  return data;
}

function describe(items) {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  const chunked = items.filter((item) => item.size >= 2 * MB).length;
  console.log("[list] " + items.length + " 个文件 · " + (total / MB).toFixed(1) + "MB · 平均 " + (total / items.length / MB).toFixed(2) + "MB");
  console.log("[list] 其中 " + chunked + " 个 >=2MB（多分片路径）、" + (items.length - chunked) + " 个 <2MB（Small file 单连接路径）");
  return total;
}

function freshDir(name) {
  const dir = path.join(os.tmpdir(), "naiwa-download-bench", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function run(label, items, concurrent, totalBytes) {
  const dir = freshDir(label + "-" + concurrent);
  const jobs = items.map((item, index) => ({
    url: item.url,
    dest: path.join(dir, String(index).padStart(2, "0") + "-" + path.basename(item.path)),
    sha1: item.sha1,
    size: item.size,
  }));
  const startedAt = Date.now();
  const { failed } = await downloadMany(jobs, {
    concurrent,
    connections: getSettings().connectionsPerFile,
    label: "bench",
  });
  const seconds = (Date.now() - startedAt) / 1000;
  const okBytes = totalBytes - failed.reduce((sum, item) => sum + (items.find((x) => x.url === item.url)?.size ?? 0), 0);
  const row = {
    concurrent,
    seconds: Number(seconds.toFixed(2)),
    mbps: Number((okBytes / MB / seconds).toFixed(2)),
    ok: jobs.length - failed.length,
    failed: failed.length,
    firstError: failed[0]?.error,
  };
  console.log(
    "[run] 并发 " + String(concurrent).padStart(2) + " · 耗时 " + seconds.toFixed(2) + "s · 平均 " + row.mbps.toFixed(2) + "MB/s · 成功 " +
      row.ok + "/" + jobs.length + (failed.length ? " · 失败 " + failed.length + "（首个：" + failed[0].error + "）" : ""),
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return row;
}

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();
  const settings = getSettings();
  console.log("[settings] concurrentDownloads=" + settings.concurrentDownloads + " connectionsPerFile=" + settings.connectionsPerFile +
    " downloadSource=" + settings.downloadSource + " → 生效源 " + resolveBase(settings.downloadSource) + " 限速=" + settings.speedLimitKbps + "KB/s");

  const mode = process.argv[2] ?? "both";
  // 第三个参数可只跑指定并发：node scripts/download-bench.js files 12
  const concs = (process.argv[3] ?? "1,8,12").split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const { main, small } = await collect();
  const groups = mode === "files" ? [["main", main]] : mode === "small" ? [["small", small]] : [["main", main], ["small", small]];
  for (const [name, items] of groups) {
    console.log("=== " + name + " ===");
    const totalBytes = describe(items);
    const rows = [];
    for (const concurrent of concs) rows.push(await run(name, items, concurrent, totalBytes));
    const base = rows[0].seconds;
    for (const row of rows) {
      console.log("[speedup] 并发 " + row.concurrent + " → " + (base / row.seconds).toFixed(2) + "x（相对并发 1）");
    }
  }
})().catch((err) => {
  console.error("BENCH FAILED: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
