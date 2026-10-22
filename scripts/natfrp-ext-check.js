const os = require("node:os");
const path = require("node:path");
const { readdirSync, readFileSync } = require("node:fs");
const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const natfrp = require(path.join(dist, "net", "natfrp"));

(async () => {
  const root = path.join(os.tmpdir(), "naiwa-natfrp-check");
  initPaths(root);
  await ensureDirs();
  await loadSettings();
  const netDir = path.join(root, "NaiWa", "net");

  // 1) 认不出的内容 + frpc 0.51 → 兜底 .ini
  const s1 = await natfrp.natfrpStart(801, { configText: "nonsense config body without sections" });
  console.log("[ext] 未知内容 log[0]=" + s1.log[s1.log.length - 1].slice(-24));
  await new Promise((r) => setTimeout(r, 2000));
  const st1 = natfrp.natfrpStatus();
  console.log("[ext] 未知内容 → running=" + st1.running + " 尾部=" + JSON.stringify(st1.log.slice(-2).map((l) => l.slice(0, 90))));
  await natfrp.natfrpStop();

  // 2) toml 内容 + frpc 0.51 → 明确报错而不是让 frpc 打哑谜
  const toml = 'serverAddr = "127.0.0.1"\nserverPort = 1\n\n[[proxies]]\nname = "x"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 25565\nremotePort = 25565\n';
  try {
    await natfrp.natfrpStart(802, { configText: toml });
    console.log("[ext] toml+0.51 未抛错（不符合预期）");
    await natfrp.natfrpStop();
  } catch (err) {
    console.log("[ext] toml+0.51 → " + err.message);
  }

  // 3) ini 回归
  const ini = "[common]\nserver_addr = 127.0.0.1\nserver_port = 1\ntoken = fake\n\n[naiwa]\ntype = tcp\nlocal_ip = 127.0.0.1\nlocal_port = 25565\nremote_port = 25565\n";
  const s3 = await natfrp.natfrpStart(803, { configText: ini });
  console.log("[ext] ini 段 running=" + s3.running);
  await new Promise((r) => setTimeout(r, 2500));
  const st3 = natfrp.natfrpStatus();
  console.log("[ext] ini 段 2.5s 后 running=" + st3.running + " 尾部=" + JSON.stringify(st3.log.slice(-2).map((l) => l.slice(0, 90))));
  console.log("[ext] stop → " + JSON.stringify(await natfrp.natfrpStop().then((s) => ({ running: s.running, tunnelId: s.tunnelId, logLines: s.log.length }))));
  console.log("[ext] net 目录=" + JSON.stringify(readdirSync(netDir)));
  for (const name of readdirSync(netDir)) {
    console.log("      " + name + " → 首行 " + JSON.stringify(readFileSync(path.join(netDir, name), "utf8").split(/\r?\n/)[0].slice(0, 46)));
  }
})().catch((e) => { console.error("[fatal] " + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
