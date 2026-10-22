// 等待微软设备码授权，成功后打印 Minecraft 档案信息并落盘结果。
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist-electron", "main");
const { initPaths, ensureDirs } = require(join(dist, "core", "paths"));
const { loadSettings } = require(join(dist, "core", "settings"));
const microsoft = require(join(dist, "auth", "microsoft"));
const accounts = require(join(dist, "auth", "accounts"));

initPaths(root);
await ensureDirs();
await loadSettings();

const stateFile = join(root, "NaiWa", "config", "ms-device.json");
const resultFile = join(root, "NaiWa", "config", "ms-login-result.json");
const { deviceCode, userCode } = JSON.parse(readFileSync(stateFile, "utf8"));
const deadline = Date.now() + 14 * 60 * 1000;
const write = (o) => writeFileSync(resultFile, JSON.stringify(o, null, 2), "utf8");

while (Date.now() < deadline) {
  const st = await microsoft.pollDeviceCode(deviceCode);
  if (st.status === "pending") { await new Promise((r) => setTimeout(r, 5000)); continue; }
  if (st.status === "error") {
    console.log("[ms] 失败：", st.message);
    write({ ok: false, code: userCode, error: st.message, at: Date.now() });
    process.exit(1);
  }
  const account = st.account;
  await accounts.setActiveAccount(account.id);
  const session = await microsoft.resolveMinecraftSession(account);
  const profile = await microsoft.getMinecraftProfile(account);
  console.log("[ms] 登录成功：", account.name, account.uuid);
  console.log("[ms] 会话 uuid：", session.uuid, "| 档案：", JSON.stringify(profile));
  write({ ok: true, accountId: account.id, name: account.name, uuid: account.uuid, profile, at: Date.now() });
  process.exit(0);
}
console.log("[ms] 超时：未在有效期内完成授权");
write({ ok: false, error: "timeout", code: userCode, at: Date.now() });
