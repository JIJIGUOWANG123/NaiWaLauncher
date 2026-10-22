// 校验：上一轮安装失败的那几个文件单独重下（证明失败是 CDN 临时卡顿，不是代码问题）
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const AdmZip = require("adm-zip");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs, getPaths } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const { downloadMany } = require(path.join(dist, "core", "http"));

const WANTED = process.argv.slice(2);

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();
  const mrpack = fs.readdirSync(getPaths().downloads).filter((name) => /\.mrpack$/i.test(name))[0];
  const zip = new AdmZip(path.join(getPaths().downloads, mrpack));
  const index = JSON.parse(zip.getEntry("modrinth.index.json").getData().toString("utf8"));
  const items = [];
  for (const file of index.files ?? []) {
    if (!WANTED.some((name) => file.path.endsWith(name))) continue;
    const url = (file.downloads ?? [])[0];
    items.push({ url, dest: path.join(os.tmpdir(), "naiwa-retry", path.basename(file.path)), sha1: file.hashes?.sha1, size: file.fileSize });
  }
  console.log("[retry] " + items.length + " 个文件：" + items.map((item) => path.basename(item.dest)).join("、"));
  const startedAt = Date.now();
  const { failed } = await downloadMany(items, { concurrent: 4, connections: 4, label: "retry" });
  const seconds = (Date.now() - startedAt) / 1000;
  console.log("[retry] 耗时 " + seconds.toFixed(1) + "s · 成功 " + (items.length - failed.length) + "/" + items.length +
    (failed.length ? " · 失败：" + failed.map((item) => path.basename(item.dest) + "(" + item.error + ")").join("、") : ""));
})().catch((err) => {
  console.error("RETRY FAILED: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
