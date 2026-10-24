// 陶瓦联机（Terracotta）内嵌可行性复跑脚本 —— 只做验证，不含产品代码。
// 用法：node scripts/experiments/terracotta/probe.cjs "D:\path\to\terracotta.exe"
// 流程：启动 --hmcl → 等端口文件 → /meta → /state → 广播假局域网 → 直到 host-ok →
//       打印邀请码与成员 → /state/ide 复位 → /panic?peaceful=true 收尾 → 清理端口文件。
// 注意：真实联机需要两台机器与真实客户端；这里只是验证 HTTP API 与状态机可用。
const { spawn, execFileSync } = require("node:child_process");
const dgram = require("node:dgram");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error("用法: node probe.cjs <terracotta.exe 路径>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFile = path.join(os.tmpdir(), "terracotta-probe-" + process.pid + ".json");
fs.rmSync(portFile, { force: true });

function log(...args) { console.log("[" + new Date().toISOString().slice(11, 23) + "]", ...args); }

async function getJson(base, route) {
  const res = await fetch(base + route, { signal: AbortSignal.timeout(4000) });
  if (res.status !== 200) throw new Error(route + " -> HTTP " + res.status);
  return res.json();
}

function broadcastFakeLan(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const payload = Buffer.from("[MOTD]Probe Fake MC[/MOTD][AD]" + port + "[/AD]", "utf8");
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.setMulticastTTL(1);
      socket.send(payload, 4445, "224.0.2.60", () => { socket.close(); resolve(); });
    });
  });
}

async function main() {
  const env = { ...process.env };
  const started = Date.now();
  const child = spawn(exe, ["--hmcl", portFile], { stdio: "ignore", env });
  log("spawned", child.pid);

  let port = 0;
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try {
      const raw = fs.readFileSync(portFile, "utf8");
      port = JSON.parse(raw).port;
      if (port) break;
    } catch {}
  }
  if (!port) { console.error("未拿到端口文件（8s 超时）"); process.exit(3); }
  log("port", port, "耗时", Date.now() - started, "ms");

  const base = "http://127.0.0.1:" + port;
  let meta = null;
  for (let i = 0; i < 50; i++) {
    try { meta = await getJson(base, "/meta"); break; } catch { await sleep(100); }
  }
  if (!meta) { console.error("/meta 无法访问"); process.exit(4); }
  log("meta", JSON.stringify(meta));
  log("state", JSON.stringify(await getJson(base, "/state")));

  await fetch(base + "/state/scanning?player=ProbeHost");
  await broadcastFakeLan(25565);
  log("已广播假局域网，等待 host-ok …");

  let last = -1;
  let room = "";
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const state = await getJson(base, "/state");
      if (typeof state.index === "number" && state.index > last) {
        last = state.index;
        log("state", JSON.stringify(state));
        if (state.state === "host-ok") { room = state.room || ""; break; }
        if (state.state === "exception") break;
      }
    } catch (err) { log("轮询失败", String(err).slice(0, 120)); }
  }
  log(room ? "host-ok 邀请码: " + room : "未到 host-ok（真实联机仍需游戏内对局域网开放）");

  await fetch(base + "/state/ide").catch(() => undefined);
  log("已 /state/ide 复位");
  try {
    await fetch(base + "/panic?peaceful=true", { signal: AbortSignal.timeout(3000) });
  } catch {
    log("/panic 连接被切断（预期）");
  }
  await sleep(1500);

  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-Process terracotta,easytier-core -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"],
      { encoding: "utf8" });
    const pids = out.split(/\s+/).filter(Boolean);
    if (pids.length) { log("残留进程，强制结束:", pids.join(",")); execFileSync("taskkill", ["/PID", pids[0], "/T", "/F"], { stdio: "ignore" }); }
    else log("已确认无残留进程");
  } catch { log("进程检查跳过"); }

  fs.rmSync(portFile, { force: true });
  log("完成；端口文件已清理");
}

main().catch((err) => { console.error(err); process.exit(1); });
