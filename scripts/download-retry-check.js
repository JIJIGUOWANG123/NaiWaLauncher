// 自检：downloadMany 的失败补下一轮（首轮失败 1 个 → 重试 → 仍失败 1 个）。
// 混入一个必然 404 的地址，其余用真实可下的 CDN 文件。
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const { downloadMany } = require(path.join(dist, "core", "http"));

const CACHE = path.join(__dirname, ".download-bench-cache.json");
const BOGUS = "https://libraries.minecraft.net/net/java/dev/jna/jna/9.9.9-does-not-exist/jna-9.9.9-does-not-exist.jar";

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();
  const { main } = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const real = main.slice(0, 5);
  const dir = path.join(os.tmpdir(), "naiwa-retry-check");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const items = real.map((item, index) => ({
    url: item.url,
    dest: path.join(dir, String(index) + "-" + path.basename(item.path)),
    sha1: item.sha1,
    size: item.size,
  }));
  items.push({ url: BOGUS, dest: path.join(dir, "06-bogus.jar") });

  console.log("[check] 6 个文件（5 个真实 + 1 个必然 404）· 并发 6");
  const startedAt = Date.now();
  const { failed } = await downloadMany(items, { concurrent: 6, connections: 4, label: "retry-check" });
  const seconds = (Date.now() - startedAt) / 1000;
  console.log("[check] 耗时 " + seconds.toFixed(1) + "s · 最终 failed = " + failed.length);
  for (const item of failed) console.log("[check] 仍失败：" + path.basename(item.dest) + " · " + item.error);
  const onDisk = items.filter((item) => fs.existsSync(item.dest) && fs.statSync(item.dest).size > 0).length;
  console.log("[check] 落盘 " + onDisk + "/" + items.length);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed.length === 1 ? 0 : 1);
})().catch((err) => {
  console.error("CHECK FAILED: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
