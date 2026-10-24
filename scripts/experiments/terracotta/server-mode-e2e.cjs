// 陶瓦联机「专用服务器模式」端到端验证：真实 terracotta.exe + 真实 UDP 组播广播 + 真实 HTTP。
// 用法（先构建主进程）：
//   node node_modules/typescript/bin/tsc -p tsconfig.main.json
//   node scripts/experiments/terracotta/server-mode-e2e.cjs
// 说明：跑的是编译后的产品代码 dist-electron/main/net/terracotta.js 本身，
//       唯一替身是 electron 的 app.getPath("userData")（只用来决定端口文件目录）。
// 覆盖：B（server 模式 host 到 host-ok + profiles + stop 后 socket/进程清理）、
//       C（lan 模式回归）、D（真实发出的报文与目标地址）。
const dgram = require("node:dgram");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../../..");
const USERDATA = path.join(os.tmpdir(), "naiwa-e2e-userdata");

// 唯一替身：主进程只用 app.getPath 放端口文件，其它一切照旧
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => USERDATA } };
  return load.apply(this, arguments);
};
const TCP_PORT = 25599; // 充当「专用服务器」的本机 TCP 监听
const LAN_GROUP = "224.0.2.60";
const LAN_PORT = 4445;

const log = (...args) => console.log("[" + new Date().toISOString().slice(11, 23) + "]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  log((ok ? "PASS " : "FAIL ") + name + (detail === undefined ? "" : " · " + detail));
  if (!ok) failures += 1;
}

function getJson(base, route) {
  return fetch(base + route, { signal: AbortSignal.timeout(4000) }).then((res) => {
    if (!res.ok) throw new Error(route + " -> HTTP " + res.status);
    return res.json();
  });
}

async function main() {
  fs.mkdirSync(USERDATA, { recursive: true });
  require(path.join(ROOT, "dist-electron/main/core/paths.js")).initPaths(ROOT);
  const tera = require(path.join(ROOT, "dist-electron/main/net/terracotta.js"));

  // ---- 专用服务器 ----
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(TCP_PORT, "127.0.0.1", resolve));
  log("专用服务器（TCP 监听）就绪：127.0.0.1:" + TCP_PORT);

  // ---- 抓包：加入同一个组播组，把启动器真实发出的报文抓下来（验收 D） ----
  const captured = [];
  let sniffer = null;
  try {
    sniffer = dgram.createSocket({ type: "udp4", reuseAddr: true });
    await new Promise((resolve, reject) => {
      sniffer.once("error", reject);
      sniffer.bind(LAN_PORT, () => {
        try { sniffer.addMembership(LAN_GROUP); } catch (err) { log("加入组播组失败：" + err.message); }
        resolve();
      });
    });
    sniffer.on("message", (msg, rinfo) => captured.push({ at: Date.now(), text: msg.toString("utf8"), from: rinfo.address + ":" + rinfo.port }));
    log("抓包 socket 就绪：" + sniffer.address().address + ":" + sniffer.address().port + "，组播组 " + LAN_GROUP);
  } catch (err) {
    log("抓包 socket 不可用（不阻塞测试）：" + err.message);
  }

  async function waitHost(label, timeoutMs) {
    const started = Date.now();
    let last = -1;
    while (Date.now() - started < timeoutMs) {
      const s = tera.terracottaStatus();
      if (s.index !== last) {
        last = s.index;
        log("  " + label + " /state → state=" + s.state + " index=" + s.index + (s.room ? " room=" + s.room : "") + " broadcasting=" + s.broadcasting + (s.problem ? " problem=" + s.problem : ""));
      }
      if (s.state === "host-ok" || s.state === "exception") return s;
      await sleep(300);
    }
    return tera.terracottaStatus();
  }

  function portFile() {
    return path.join(USERDATA, "terracotta", "port-" + process.pid + ".json");
  }

  // ================= B：server 模式 =================
  log("===== B. 专用服务器模式 host =====");
  const hostStarted = Date.now();
  const afterHost = await tera.terracottaHost("E2EHost", { mode: "server", serverPort: TCP_PORT });
  check("host 返回 mode=server", afterHost.mode === "server", "mode=" + afterHost.mode + " serverPort=" + afterHost.serverPort);
  check("进入 host-scanning 后广播已启动", afterHost.broadcasting === true, "broadcasting=" + afterHost.broadcasting);

  const okState = await waitHost("server", 40000);
  log("  到 host-ok 用时 " + (Date.now() - hostStarted) + "ms");
  check("到达 host-ok", okState.state === "host-ok", "state=" + okState.state);
  check("拿到邀请码", typeof okState.room === "string" && okState.room.startsWith("U/"), "room=" + okState.room);
  check("host-ok 后广播仍在继续", okState.broadcasting === true, "broadcasting=" + okState.broadcasting);

  // 原始 /state + profiles（验收 B 要求贴 HOST 条目）
  const published = JSON.parse(fs.readFileSync(portFile(), "utf8")).port;
  const rawState = await getJson("http://127.0.0.1:" + published, "/state");
  log("  原始 /state = " + JSON.stringify(rawState));

  // 验收 D：真实报文
  const lanFrames = captured.filter((item) => item.text.startsWith("[MOTD]NaiWa Server"));
  log("  抓到的启动器报文（共 " + captured.length + " 帧，其中专用服务器 " + lanFrames.length + " 帧）：");
  for (const frame of captured.slice(0, 6)) log("    ← " + frame.text + "   from " + frame.from);
  check("广播报文内容与端口正确", lanFrames.some((item) => item.text === "[MOTD]NaiWa Server[/MOTD][AD]" + TCP_PORT + "[/AD]"), lanFrames[0] && lanFrames[0].text);
  const moduleLog = await tera.terracottaLog();
  const broadcastLine = moduleLog.split(/\r?\n/).find((line) => line.includes("广播 [MOTD]"));
  log("  模块日志里的发送记录：" + (broadcastLine || "(未找到)"));
  check("模块日志记录了目标地址 224.0.2.60:4445", Boolean(broadcastLine && broadcastLine.includes("224.0.2.60:4445")), broadcastLine);

  // ---- stop ----
  const afterStop = await tera.terracottaStop();
  const stoppedAt = Date.now();
  check("stop 后 broadcasting=false", afterStop.broadcasting === false, "broadcasting=" + afterStop.broadcasting);
  check("stop 后 running=false", afterStop.running === false, "running=" + afterStop.running);
  check("stop 后 mode 复位为 lan", afterStop.mode === "lan", "mode=" + afterStop.mode);
  await sleep(3200);
  const afterStopFrames = captured.filter((item) => item.at > stoppedAt);
  check("stop 之后不再有新的广播帧（socket 已关闭）", afterStopFrames.length === 0, "新增帧=" + afterStopFrames.length);
  if (sniffer) { try { sniffer.close(); } catch {} }

  const tasklist = execFileSync("tasklist", ["/FI", "IMAGENAME eq terracotta.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  check("没有残留 terracotta.exe", /No tasks are running|INFO:/i.test(tasklist), tasklist.trim().slice(0, 80) || "(空)");
  const listening = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  check("陶瓦 HTTP 端口已释放", !listening.split(/\r?\n/).some((line) => /LISTENING/i.test(line) && line.includes(":" + published)), "port=" + published);

  // ================= C：lan 模式回归 =================
  log("===== C. lan 模式回归（原行为）=====");
  const lanStatus = await tera.terracottaHost("E2ELan");
  check("lan 模式 host 不带 options", lanStatus.mode === "lan", "mode=" + lanStatus.mode);
  check("lan 模式不启动广播", lanStatus.broadcasting === false, "broadcasting=" + lanStatus.broadcasting);
  check("lan 模式没有 serverPort", lanStatus.serverPort === undefined, "serverPort=" + lanStatus.serverPort);
  // /state/scanning 之后要等一次轮询（500ms）才把 host-scanning 读回来
  const scanningDeadline = Date.now() + 5000;
  let scanning = tera.terracottaStatus();
  while (scanning.state === "waiting" && Date.now() < scanningDeadline) {
    await sleep(200);
    scanning = tera.terracottaStatus();
  }
  check("lan 模式进入 host-scanning", scanning.state === "host-scanning", "state=" + scanning.state);

  // 模拟游戏内「对局域网开放」发出的 Minecraft 局域网广播
  const gameSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const gamePayload = Buffer.from("[MOTD]E2E LAN World[/MOTD][AD]" + TCP_PORT + "[/AD]", "utf8");
  const gameTimer = setInterval(() => {
    try { gameSocket.send(gamePayload, LAN_PORT, LAN_GROUP); } catch {}
  }, 1500);
  gameSocket.bind(() => {
    try { gameSocket.setBroadcast(true); gameSocket.setMulticastTTL(1); } catch {}
    gameSocket.send(gamePayload, LAN_PORT, LAN_GROUP);
  });
  const lanOk = await waitHost("lan", 40000);
  clearInterval(gameTimer);
  try { gameSocket.close(); } catch {}
  check("lan 模式仍能识别游戏开出的局域网端口", lanOk.state === "host-ok", "state=" + lanOk.state + " room=" + lanOk.room);
  const lanStopped = await tera.terracottaStop();
  check("lan 模式停止后 broadcasting=false", lanStopped.broadcasting === false, "broadcasting=" + lanStopped.broadcasting);

  // ================= 广播失败：优雅降级 =================
  log("===== 广播失败（端口被占/无可用网卡）时的降级 =====");
  const dgramModule = require("node:dgram");
  const originalCreate = dgramModule.createSocket;
  dgramModule.createSocket = () => {
    throw new Error("EADDRNOTAVAIL: 模拟端口被占 / 没有可用网卡");
  };
  let degraded;
  try {
    degraded = await tera.terracottaHost("E2EDegrade", { mode: "server", serverPort: TCP_PORT });
  } finally {
    dgramModule.createSocket = originalCreate;
  }
  check("广播建不起来时 host 仍然成功（不阻塞主流程）", degraded.running === true && degraded.state !== "exception", "running=" + degraded.running + " state=" + degraded.state);
  check("broadcasting=false 且给出了失败原因", degraded.broadcasting === false && typeof degraded.broadcastError === "string" && degraded.broadcastError.length > 0, degraded.broadcastError);
  await sleep(3000);
  const degradedLater = tera.terracottaStatus();
  check("没有广播时陶瓦停在 host-scanning（预期，界面会提示广播不可用）", degradedLater.state === "host-scanning", "state=" + degradedLater.state);
  const degradedStopped = await tera.terracottaStop();
  check("降级后 stop 干净收尾", degradedStopped.running === false && degradedStopped.broadcasting === false, "running=" + degradedStopped.running + " broadcasting=" + degradedStopped.broadcasting);

  await new Promise((resolve) => server.close(resolve));
  log("===== 结果：" + (failures === 0 ? "全部通过" : failures + " 项失败") + " =====");
  return failures;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("E2E 失败：", err);
    process.exit(1);
  },
);
