// 自检：整合包的目录穿越防护（files[] 与 overrides 两条路径）与实例重名规则。
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");
const AdmZip = require("adm-zip");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs, getPaths, instanceDir } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const { createTask } = require(path.join(dist, "core", "events"));
const { createInstanceRecord, deleteInstance, listInstances } = require(path.join(dist, "minecraft", "instances"));
const modpack = require(path.join(dist, "mods", "modpack"));

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + " | " + label + (detail ? " | " + detail : ""));
  if (!ok) failures += 1;
}

const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();

  const goodJar = Buffer.from("good-mod-content-for-selfcheck");
  const evilJar = Buffer.from("evil-should-never-land");
  const served = {
    "/good.jar": goodJar,
    "/evil.jar": evilJar,
  };
  const server = http.createServer((req, res) => {
    const body = served[req.url];
    if (!body) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  // 构造带穿越条目的 .mrpack：files[] 里两条越界，overrides 里一条越界
  const indexJson = {
    formatVersion: 1,
    name: "Self Check Pack",
    versionId: "1.0.0",
    dependencies: { minecraft: "1.21.4", "fabric-loader": "0.16.9" },
    files: [
      { path: "mods/good.jar", downloads: [base + "/good.jar"], hashes: { sha1: sha1(goodJar) } },
      { path: "../evil.txt", downloads: [base + "/evil.jar"], hashes: {} },
      { path: "/absolute-evil.txt", downloads: [base + "/evil.jar"], hashes: {} },
    ],
  };
  const zip = new AdmZip();
  zip.addFile("modrinth.index.json", Buffer.from(JSON.stringify(indexJson)));
  zip.addFile("overrides/good.txt", Buffer.from("override-ok"));
  // adm-zip 的 addFile 会把 ".." 规范化掉，所以先按合法名加进去再把 entryName 改回穿越路径，
  // 这样才能造出真实存在的恶意 zip（索引与 overrides 两条路径都要防）
  zip.addFile("overrides/evil3.txt", Buffer.from("evil-override"));
  zip.getEntry("overrides/evil3.txt").entryName = "overrides/../evil3.txt";
  // 不在 overrides/ 下的条目一律不认（.mrpack 规范只解 overrides）
  zip.addFile("stray.txt", Buffer.from("not-an-override"));
  const workDir = path.join(root, ".scratch", "modpack-selfcheck");
  fs.mkdirSync(workDir, { recursive: true });
  const zipPath = path.join(workDir, "selfcheck.mrpack");
  zip.writeZip(zipPath);
  console.log("[zip] 条目 " + new AdmZip(zipPath).getEntries().map((e) => e.entryName).join(" , "));

  // 1) 解析：加载器识别
  const index = modpack.parseModpackIndex(indexJson);
  check("解析 mcVersion", index.mcVersion === "1.21.4", "mcVersion=" + index.mcVersion);
  check("解析加载器", index.loader === "fabric" && index.loaderVersion === "0.16.9", index.loader + " / " + index.loaderVersion);
  check("解析 files 数量", index.files.length === 3, "files=" + index.files.length);

  // 2) 纯函数：路径清洗与下载计划
  let rejectedPath = "";
  try {
    modpack.safeModpackPath("../evil.txt");
  } catch (err) {
    rejectedPath = err.message;
  }
  check("safeModpackPath 拒绝 ../evil.txt", rejectedPath.includes("穿越"), rejectedPath);

  // 3) 真实落盘：建一个空实例（不装原版，只测落盘逻辑）后跑 installModpackEntities
  const instance = await createInstanceRecord({
    name: "自检-路径安全",
    mcVersion: "1.21.4",
    loader: "vanilla",
    versionId: "1.21.4",
  });
  const gameDir = instanceDir(instance.id);
  const task = createTask("mod", "自检整合包");
  const stats = await modpack.installModpackEntities(instance, index, zipPath, task);
  console.log("[stats] " + JSON.stringify(stats));

  check("越界 files 条目被拒绝（2 条）", stats.rejected.length === 2, JSON.stringify(stats.rejected));
  check("合法文件下载成功（1 个）", stats.downloaded === 1, "downloaded=" + stats.downloaded);
  check("合法文件落在实例 mods 下", fs.existsSync(path.join(gameDir, "mods", "good.jar")),
    path.join(gameDir, "mods", "good.jar"));
  check("overrides 解压成功（1 个）", stats.overridesWritten === 1 && fs.readFileSync(path.join(gameDir, "good.txt"), "utf8") === "override-ok",
    "overridesWritten=" + stats.overridesWritten);
  check("越界 overrides 条目被拒绝（1 条）", stats.overridesRejected === 1, "overridesRejected=" + stats.overridesRejected);

  const outside = [
    path.join(getPaths().instances, "evil.txt"),
    path.join(getPaths().gameRoot, "evil.txt"),
    path.join(getPaths().root, "evil.txt"),
    path.join(getPaths().instances, "evil3.txt"),
    path.join(getPaths().gameRoot, "evil3.txt"),
    path.join(getPaths().root, "evil3.txt"),
    path.join(getPaths().root, "absolute-evil.txt"),
    path.join(getPaths().root, "stray.txt"),
    "D:\\absolute-evil.txt",
  ];
  const written = outside.filter((p) => fs.existsSync(p));
  check("实例根目录之外没有任何越界文件", written.length === 0, written.join(" , ") || "全部不存在");

  // 4) 重名规则
  check("cleanInstanceName 截到 32 字符", modpack.cleanInstanceName("  " + "x".repeat(40) + "  ").length === 32,
    "len=" + modpack.cleanInstanceName("  " + "x".repeat(40) + "  ").length);
  const taken = ["重名测试", "重名测试 (2)"];
  check("重名追加 (3)", modpack.uniqueInstanceName("重名测试", taken) === "重名测试 (3)", modpack.uniqueInstanceName("重名测试", taken));
  const longName = "L".repeat(32);
  const longNext = modpack.uniqueInstanceName(longName, [longName]);
  check("长名重名后仍 ≤32 且带 (2)", longNext.endsWith(" (2)") && longNext.length === 32, longNext + " len=" + longNext.length);

  // 端到端重名：现有实例名参与判重
  const first = await createInstanceRecord({ name: "自检-重名", mcVersion: "1.21.4", loader: "vanilla", versionId: "1.21.4" });
  const names = (await listInstances()).map((meta) => meta.name);
  const nextName = modpack.uniqueInstanceName("自检-重名", names);
  check("已存在同名实例 → 新名带 (2)", nextName === "自检-重名 (2)", nextName);
  const second = await createInstanceRecord({ name: nextName, mcVersion: "1.21.4", loader: "vanilla", versionId: "1.21.4" });
  check("落盘后的实例名就是带 (2) 的名字", second.name === "自检-重名 (2)", second.name);

  await deleteInstance(first.id);
  await deleteInstance(second.id);
  await deleteInstance(instance.id);
  check("自检实例已清理", !fs.existsSync(instanceDir(instance.id)), instance.id);

  server.close();
  console.log(failures === 0 ? "=== ALL PASS ===" : "=== " + failures + " FAILED ===");
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("自检异常：" + (err && err.stack ? err.stack : String(err)));
  process.exit(2);
});
