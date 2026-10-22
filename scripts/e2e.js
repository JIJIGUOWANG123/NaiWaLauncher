// 端到端联调：真编译产物 + 真网络 + 真启动。用法：
//   node scripts/e2e.js <mcVersion> <loader> [--launch]
// 例：node scripts/e2e.js 1.20.1 fabric --launch
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs, getPaths, instanceDir } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const { setEventSink } = require(path.join(dist, "core", "events"));
const { setLogSink } = require(path.join(dist, "core", "logger"));
const { createInstance, listInstances } = require(path.join(dist, "minecraft", "instances"));
const { buildLaunchArgs } = require(path.join(dist, "minecraft", "launch"));

const mcVersion = process.argv[2] || "1.20.1";
const loader = process.argv[3] || "fabric";
const doLaunch = process.argv.includes("--launch");

(async () => {
  const root = path.join(__dirname, "..");
  initPaths(root);
  await ensureDirs();
  await loadSettings();
  setLogSink((l) => { if (l.level !== "info") console.log("[log:" + l.level + "]", l.message); });
  let last = 0;
  setEventSink({
    progress: (p) => {
      if (Date.now() - last < 2000) return;
      last = Date.now();
      const pct = p.percent === null ? "?" : (p.percent * 100).toFixed(1) + "%";
      console.log("[task]", p.kind, "|", p.stage, "|", pct, "|", p.filesDone + "/" + p.filesTotal,
        "|", (p.downloadedBytes / 1048576).toFixed(1) + "MB", "|", (p.bytesPerSecond / 1048576).toFixed(1) + "MB/s");
    },
    done: (r) => console.log("[task-done]", r.kind, r.label, r.ok ? "OK" : "FAIL " + r.error),
  });

  console.log("[root]", getPaths().root);
  const t0 = Date.now();
  const inst = await createInstance({ name: "E2E-" + loader, mcVersion, loader, memoryMb: 4096 });
  console.log("[instance]", JSON.stringify({ id: inst.id, versionId: inst.versionId, loader: inst.loader, loaderVersion: inst.loaderVersion }), "in", Date.now() - t0, "ms");
  console.log("[instances]", (await listInstances()).map((i) => i.id + ":" + i.versionId).join(", "));

  const { exe, args } = await buildLaunchArgs(inst);
  console.log("[exe]", exe);
  console.log("[args-count]", args.length);
  const unresolved = args.filter((a) => a.includes("${"));
  console.log("[unresolved-templates]", unresolved.length, unresolved.slice(0, 3));

  if (doLaunch) {
    const gameDir = instanceDir(inst.id);
    const options = path.join(gameDir, "options.txt");
    if (fs.existsSync(options)) {
      const head = fs.readFileSync(options, "utf8").split("\n").slice(0, 3);
      console.log("[options]", JSON.stringify(head));
    }
    await new Promise((resolve) => {
      const child = cp.spawn(exe, args, { cwd: gameDir, stdio: ["ignore", "pipe", "pipe"] });
      let ok = false;
      const onData = (buf) => {
        const text = buf.toString("utf8");
        if (!ok && /Backend library|Sound engine started|Setting user/.test(text)) {
          console.log("[game]", text.split("\n").filter((l) => /Setting user|Sound engine|LWJGL|Stopping/.test(l)).join(" | ").slice(0, 400));
        }
        if (!ok && /Sound engine started|Backend library/.test(text)) {
          ok = true;
          console.log("[game] 进入主菜单，45s 后收尾");
          setTimeout(() => { child.kill(); resolve(); }, 1000);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (e) => { console.log("[game-error]", String(e).slice(0, 200)); resolve(); });
      setTimeout(() => {
        if (!ok) console.log("[game] 45s 未匹配到主菜单标志，收尾");
        child.kill();
        resolve();
      }, 90000);
    });
    console.log("[launch] done");
  }
  process.exit(0);
})().catch((e) => { console.log("[e2e-failed]", String(e && e.stack || e).slice(0, 900)); process.exit(1); });
