// 微软登录链路自检：打印设备码 → 等你在浏览器授权 → 打印 XBL/XSTS/Minecraft 档案结果。
// 用法：node scripts/test-ms-login.mjs [clientId]
// 需要在 D:\minecraft 下先 pnpm build（生成 dist-electron）。
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const dist = resolve(import.meta.dirname, "..", "dist-electron", "main");
const { initPaths, ensureDirs } = require(`${dist}/core/paths`);
const { loadSettings, updateSettings } = require(`${dist}/core/settings`);
const microsoft = require(`${dist}/auth/microsoft`);

initPaths(resolve(import.meta.dirname, ".."));
await ensureDirs();
await loadSettings();
const clientId = process.argv[2];
if (clientId) await updateSettings({ microsoftClientId: clientId });

console.log("== 1/2 申请设备码 ==");
let challenge;
try {
  challenge = await microsoft.beginDeviceCode();
} catch (e) {
  console.error("失败：", e && e.message ? e.message : e);
  console.error("\n提示：若报 AADSTS70002，请到 Azure 门户 → 应用注册 → 身份验证 → 允许公共客户端流 = 是。");
  process.exit(1);
}
console.log("请在浏览器打开：", challenge.verificationUri);
console.log("输入代码：", challenge.userCode);
console.log("（" + Math.round(challenge.expiresIn / 60) + " 分钟内有效）\n");

console.log("== 2/2 等待授权 ==");
const deadline = Date.now() + challenge.expiresIn * 1000;
let account;
while (Date.now() < deadline) {
  const state = await microsoft.pollDeviceCode(challenge.deviceCode);
  if (state.status === "pending") { await new Promise((r) => setTimeout(r, Math.max(2, challenge.interval) * 1000)); continue; }
  if (state.status === "error") { console.error("失败：", state.message); process.exit(1); }
  account = state.account;
  break;
}
if (!account) { console.error("超时：未在有效期内完成授权"); process.exit(1); }
console.log("登录成功：", account.name, account.uuid);

const session = await microsoft.resolveMinecraftSession(account);
console.log("Minecraft 会话：", JSON.stringify({ name: session.name, uuid: session.uuid, hasToken: !!session.accessToken }));
const profile = await microsoft.getMinecraftProfile(account);
console.log("档案接口：", JSON.stringify(profile));

