const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readFileSync, statSync } = require("node:fs");

const dist = path.join(__dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(path.join(dist, "core", "paths"));
const { loadSettings, updateSettings, getSettings } = require(path.join(dist, "core", "settings"));
const natfrp = require(path.join(dist, "net", "natfrp"));

const ROOT = path.join(os.tmpdir(), "naiwa-natfrp-check");
const API = "https://api.natfrp.com/v4";
const realFetch = globalThis.fetch;

const line = (tag, text) => console.log("[" + tag + "] " + text);
const short = (s, n) => String(s).replace(/\s+/g, " ").slice(0, n);
const md5 = (file) => crypto.createHash("md5").update(readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stubUserInfo(payload) {
  let hits = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v4/user/info")) {
      hits += 1;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
  return () => { globalThis.fetch = realFetch; return hits; };
}

(async () => {
  initPaths(ROOT);
  await ensureDirs();
  await loadSettings();
  await updateSettings({ natfrpToken: "" });
  line("root", ROOT + " （临时根目录，不碰用户真实配置）");
  line("settings", "natfrpToken=" + JSON.stringify(getSettings().natfrpToken));

  // ---------- A 无 token ----------
  for (const [name, call] of [
    ["natfrpTunnels", () => natfrp.natfrpTunnels()],
    ["natfrpUser", () => natfrp.natfrpUser()],
    ["natfrpNodes", () => natfrp.natfrpNodes()],
    ["natfrpCreate", () => natfrp.natfrpCreate("x", 1, 25565)],
    ["natfrpStart", () => natfrp.natfrpStart(123)],
  ]) {
    try {
      await call();
      line("A", name + " 未抛错（不符合预期）");
    } catch (err) {
      line("A", name + "() → " + err.message);
    }
  }

  // ---------- B token 无效 ----------
  await updateSettings({ natfrpToken: "invalid" });
  const raw401 = await realFetch(API + "/user/info", { headers: { authorization: "Bearer invalid" } });
  line("B", "原始响应 HTTP " + raw401.status + " · body=" + short(await raw401.text(), 120) + "（注意 HTTP 是 500，code 在正文里）");
  for (const [name, call] of [["natfrpUser", () => natfrp.natfrpUser()], ["natfrpTunnels", () => natfrp.natfrpTunnels()]]) {
    try {
      await call();
      line("B", name + " 未抛错（不符合预期）");
    } catch (err) {
      line("B", name + "() → " + err.message + "  [err.code=" + err.code + ", err.status=" + err.status + "]");
    }
  }

  // ---------- C /system/clients + ensureFrpc 真实下载 ----------
  const clients = await (await realFetch(API + "/system/clients")).json();
  const win = clients.frpc.archs.windows_amd64;
  line("C", "frpc.ver=" + clients.frpc.ver + " · archs 分类数=" + Object.keys(clients.frpc.archs).length);
  line("C", "windows_amd64.url=" + win.url);
  line("C", "windows_amd64.hash=" + win.hash + "（长度 " + win.hash.length + " → MD5）· size=" + win.size);
  const startedAt = Date.now();
  const exe = await natfrp.ensureFrpc();
  const elapsed = Date.now() - startedAt;
  const exeSize = statSync(exe).size;
  const exeMd5 = md5(exe);
  line("C", "ensureFrpc → " + exe);
  line("C", "下载用时 " + elapsed + "ms · 文件 " + exeSize + " 字节 · 与接口 size 一致=" + (exeSize === win.size));
  line("C", "文件 MD5=" + exeMd5 + " · 与接口 hash 一致=" + (exeMd5 === win.hash));
  const again = Date.now();
  await natfrp.ensureFrpc();
  line("C", "二次 ensureFrpc 用时 " + (Date.now() - again) + "ms（已存在且一致 → 跳过下载）");
  for (const flag of ["-v", "--version"]) {
    const out = spawnSync(exe, [flag], { encoding: "utf8", windowsHide: true });
    const text = ((out.stdout || "") + (out.stderr || "")).trim();
    line("C", "frpc " + flag + " → exit=" + out.status + " · " + short(text, 220));
    if (text) break;
  }

  // ---------- F 打桩 /user/info 映射 ----------
  const payload = {
    id: 1001,
    name: "奶娃",
    email: "nw@example.com",
    group: { name: "VIP-2", level: 2, expires: 0 },
    traffic: [12345678, 987654321],
    sign: { signed: false, days: 3, last: "2026-10-21", config: [1, 2] },
  };
  const restoreF = stubUserInfo(payload);
  const user = await natfrp.natfrpUser();
  line("F", "打桩入参 traffic=[12345678, 987654321] sign={signed:false, days:3, last:'2026-10-21', config:[1,2]}");
  line("F", "映射结果 " + JSON.stringify(user));
  line("F", "字段清单（应无 signRange/signLast）=" + JSON.stringify(Object.keys(user)));
  line("F", "  id=" + user.id + " name=" + user.name + " email=" + user.email + " groupName=" + user.groupName);
  line("F", "  trafficToday=" + user.trafficToday + "（traffic[0]=12345678）trafficLeft=" + user.trafficLeft + "（traffic[1]=987654321）");
  line("F", "  signed=" + user.signed + " signDays=" + user.signDays);
  line("F", "stub 命中次数=" + restoreF());

  const restoreF2 = stubUserInfo({ id: 7, name: "closed", traffic: [0, 100], sign: { signed: true, days: 9, last: "2026-10-20", config: false } });
  const user2 = await natfrp.natfrpUser();
  line("F", "已签到账号：signed=" + user2.signed + " signDays=" + user2.signDays + " trafficLeft=" + user2.trafficLeft + " 字段=" + JSON.stringify(Object.keys(user2)));
  restoreF2();

  const restoreF3 = stubUserInfo({ id: 8, name: "banned", ban: { title: "该账户已被冻结", reason: "违规穿透公开游戏" } });
  try {
    await natfrp.natfrpUser();
    line("F", "冻结账号未抛错（不符合预期）");
  } catch (err) {
    line("F", "冻结账号 → " + err.message);
  }
  restoreF3();

  // ---------- G 进程管理（打桩配置文本） ----------
  const start1 = await natfrp.natfrpStart(999999, { configText: "this is not valid toml =" });
  line("G", "第一段 start(running=" + start1.running + ") log[0]=" + short(start1.log[0] || "", 160));
  await sleep(2500);
  const afterBad = natfrp.natfrpStatus();
  line("G", "配置非法 → running=" + afterBad.running + " tunnelId=" + JSON.stringify(afterBad.tunnelId) + " log 行数=" + afterBad.log.length);
  for (const l of afterBad.log.slice(0, 4)) console.log("    | " + short(l, 150));

  const slowConfig = "[common]\nserver_addr = 127.0.0.1\nserver_port = 1\ntoken = fake_token_for_check\n\n[naiwa-mc]\ntype = tcp\nlocal_ip = 127.0.0.1\nlocal_port = 25565\nremote_port = 25565\n";
  const start2 = await natfrp.natfrpStart(123456, { configText: slowConfig });
  line("G", "第二段 start → running=" + start2.running + " tunnelId=" + start2.tunnelId + " frpcReady=" + start2.frpcReady);
  line("G", "  配置文件=" + short(start2.log[0] || "", 170));
  await sleep(3000);
  const live = natfrp.natfrpStatus();
  line("G", "3 秒后 running=" + live.running + " address=" + JSON.stringify(live.address) + " log 行数=" + live.log.length);
  for (const l of live.log.slice(0, 5)) console.log("    | " + short(l, 150));
  const stopped = await natfrp.natfrpStop();
  line("G", "stop → running=" + stopped.running + " tunnelId=" + JSON.stringify(stopped.tunnelId) + " address=" + JSON.stringify(stopped.address) + " log 行数=" + stopped.log.length + "（保留 ≤50）");
  for (const l of stopped.log.slice(-4)) console.log("    | " + short(l, 150));

  // ---------- H 地址解析 ----------
  line("H", "frpc 输出地址解析：");
  for (const sample of [
    "2026/10/21 12:00:00 [I] [proxy/tcp/mc] start proxy success, remote_addr: cn-1.frp.one:34567",
    "[I] [my-tunnel] start proxy success: hk-2.natfrp.io:25800",
    "2026/10/21 12:00:00 [I] [service.go:130] try to connect to server...",
    "[W] login to server failed: dial tcp 127.0.0.1:1: connectex: No connection could be made",
    "远程地址: jp-3.frp.one:10233",
  ]) {
    console.log("    | " + short(sample, 88) + "  =>  " + JSON.stringify(natfrp.parseFrpcAddress(sample)));
  }

  line("done", "全部自检执行完毕");
})().catch((err) => {
  console.error("[fatal] " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
