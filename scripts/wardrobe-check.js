// 衣柜（本地皮肤库）+ 角色切换自检：真实读写 NaiWa/skins、真实跑一次 authserver 交互（打桩服务端）。
const assert = require("node:assert");
const os = require("node:os");
const zlib = require("node:zlib");
const path = require("node:path");
const fs = require("node:fs/promises");

const root = path.join(os.tmpdir(), "naiwa-wardrobe-check-" + Date.now().toString(36));
const paths = require("../dist-electron/main/core/paths");
paths.initPaths(root);

const accounts = require("../dist-electron/main/auth/accounts");
const skin = require("../dist-electron/main/auth/skin");
const ygg = require("../dist-electron/main/auth/yggdrasil");

const dir = path.join(root, "NaiWa", "skins");
const out = (label, value) => console.log(label, typeof value === "string" ? value : JSON.stringify(value, null, 2));

// ---- 真 PNG（IHDR + IDAT + IEND，CRC 正确）----
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, tint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * stride;
    raw[off] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = off + 1 + x * 3;
      raw[p] = (x * 4 + tint) & 0xff;
      raw[p + 1] = (y * 4) & 0xff;
      raw[p + 2] = tint & 0xff;
    }
  }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- authserver 打桩 ----
const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const calls = [];
function reply(status, body) {
  return {
    status,
    headers: { get: () => "application/json" },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}
global.fetch = async (url, init = {}) => {
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, url, body });
  if (method === "GET" && url === "https://stub.local/api/yggdrasil") {
    return reply(200, { meta: { serverName: "Stub 皮肤站" }, signaturePublickey: "stub-key", skinDomains: [] });
  }
  if (method === "POST" && url.endsWith("/authserver/authenticate")) {
    return reply(200, {
      accessToken: "access-1",
      clientToken: "client-1",
      selectedProfile: { id: ID_A, name: "Alice" },
      availableProfiles: [
        { id: ID_A, name: "Alice" },
        { id: ID_B, name: "Bob" },
      ],
    });
  }
  if (method === "POST" && url.endsWith("/authserver/refresh")) {
    return reply(200, {
      accessToken: "access-2",
      clientToken: "client-1",
      selectedProfile: { id: body.selectedProfile.id, name: "Bob" },
    });
  }
  if (method === "POST" && url.endsWith("/authserver/validate")) return reply(204, undefined);
  throw new Error("未打桩的请求：" + method + " " + url);
};

(async () => {
  console.log("== 临时根目录：" + root);

  // ---------- 1. 衣柜 ----------
  await fs.mkdir(dir, { recursive: true });
  const pngA = makePng(64, 64, 40);
  const pngB = makePng(64, 64, 200);
  await fs.writeFile(path.join(dir, "红石小子.png"), pngA);
  await new Promise((r) => setTimeout(r, 30));
  await fs.writeFile(path.join(dir, "青金石.png"), pngB);

  const first = await skin.listWardrobe();
  assert.strictEqual(first.length, 2, "初始应有 2 条");
  console.log("\n== [1] listWardrobe 初始 2 条 ==");
  out("", first.map((s) => ({ name: s.name, url: s.url, sizeBytes: s.sizeBytes, updatedAt: new Date(s.updatedAt).toISOString() })));
  assert.ok(first[0].url.startsWith("file:///"), "url 必须是 file:// 直链");
  assert.ok(first[0].updatedAt >= first[1].updatedAt, "必须按 updatedAt 倒序");
  assert.strictEqual(first[0].sizeBytes, pngB.length, "sizeBytes 必须等于真实字节数");

  const incoming = path.join(root, "incoming", "战损 Steve.PNG");
  await fs.mkdir(path.dirname(incoming), { recursive: true });
  await fs.writeFile(incoming, makePng(64, 64, 120));
  const addedName = await skin.addToWardrobe(incoming);
  out("\n== [2] addToWardrobe 返回文件名 ==", addedName);
  assert.ok(/^战损 Steve-\d{13}\.png$/.test(addedName), "文件名必须是 <原名>-<时间戳>.png，实际 " + addedName);
  const second = await skin.listWardrobe();
  assert.strictEqual(second.length, 3, "复制后应为 3 条");
  out("衣柜现在 " + second.length + " 条", second.map((s) => s.name));

  await skin.removeFromWardrobe(addedName);
  const third = await skin.listWardrobe();
  assert.strictEqual(third.length, 2, "删除后应为 2 条");
  out("\n== [3] removeFromWardrobe 后 ==", third.map((s) => s.name));

  let traversal = "";
  try {
    await skin.removeFromWardrobe("../evil.png");
  } catch (err) {
    traversal = err.message;
  }
  out("\n== [4] removeFromWardrobe('../evil.png') 被拒 ==", traversal || "!!! 未被拒绝");
  assert.ok(traversal.includes("不能删除衣柜以外的文件"), "路径穿越必须被拒绝");
  // 穿越确实没删掉外面的文件
  await fs.mkdir(path.join(root, "NaiWa"), { recursive: true });
  await fs.writeFile(path.join(root, "NaiWa", "evil.png"), pngA);
  let stillThere = true;
  try {
    await skin.removeFromWardrobe("../evil.png");
  } catch { /* 预期 */ }
  stillThere = await fs.access(path.join(root, "NaiWa", "evil.png")).then(() => true, () => false);
  out("衣柜外的 evil.png 仍在 =", String(stillThere));
  assert.ok(stillThere, "衣柜外的文件不能被删");

  let badSize = "";
  const small = path.join(root, "incoming", "small.png");
  await fs.writeFile(small, makePng(32, 32, 10));
  try {
    await skin.addToWardrobe(small);
  } catch (err) {
    badSize = err.message;
  }
  out("尺寸不符被拒 =", badSize);
  assert.ok(badSize.includes("64×64"), "尺寸校验必须生效");

  // ---------- 2. 第三方登录带 availableProfiles ----------
  const yggAccount = await ygg.loginYggdrasil("stub.local", "user@stub", "pw");
  out("\n== [5] 登录后账号里的 profiles ==", yggAccount.yggdrasil.profiles);
  assert.strictEqual(yggAccount.yggdrasil.profiles.length, 2, "登录应存下 2 条角色");
  assert.strictEqual(yggAccount.uuid, ID_A);

  const before = await skin.listSkinProfiles(yggAccount.id);
  out("listSkinProfiles（切换前）=", before);
  assert.deepStrictEqual(before.map((p) => p.active), [true, false]);

  // ---------- 3. 切换角色 ----------
  calls.length = 0;
  await skin.selectProfile(yggAccount.id, ID_B);
  const refreshCall = calls.find((c) => c.url.endsWith("/authserver/refresh"));
  out("\n== [6] refresh 请求 ==", { url: refreshCall.url, body: refreshCall.body });
  assert.strictEqual(refreshCall.body.selectedProfile.id, ID_B, "selectedProfile.id 必须是目标角色");
  assert.strictEqual(refreshCall.body.accessToken, "access-1");
  assert.strictEqual(refreshCall.body.clientToken, "client-1");

  const switched = await accounts.getAccount(yggAccount.id);
  out("切换后账号 =", { uuid: switched.uuid, name: switched.name, accessToken: switched.yggdrasil.accessToken });
  assert.strictEqual(switched.uuid, ID_B, "账号 uuid 必须换成新角色");
  assert.strictEqual(switched.name, "Bob", "账号 name 必须换成新角色");
  assert.strictEqual(switched.yggdrasil.accessToken, "access-2", "必须存下 refresh 返回的新令牌");
  out("listSkinProfiles（切换后）=", await skin.listSkinProfiles(yggAccount.id));

  // 失败路径文案
  let failText = "";
  try {
    await skin.selectProfile(yggAccount.id, "cccccccccccccccccccccccccccccccc");
  } catch (err) {
    failText = err.message;
  }
  out("切换失败文案 =", failText);
  assert.ok(failText.startsWith("切换角色失败："), "失败必须是「切换角色失败：<原因>」");

  // ---------- 4. 微软 / 离线 ----------
  const ms = await accounts.upsertMicrosoftAccount({
    name: "MSPlayer", uuid: "11112222333344445555666677778888",
    refreshToken: "ms-refresh", accessToken: "ms-access", expiresAt: Date.now() + 3600_000,
  });
  const msProfiles = await skin.listSkinProfiles(ms.id);
  out("\n== [7] 微软 listSkinProfiles ==", msProfiles);
  assert.strictEqual(msProfiles.length, 1);
  assert.strictEqual(msProfiles[0].active, true);

  const offline = await accounts.createOffline("OfflineUser");
  const offlineProfiles = await skin.listSkinProfiles(offline.id);
  out("离线 listSkinProfiles =", offlineProfiles);
  assert.deepStrictEqual(offlineProfiles, []);

  let msSwitch = "";
  try {
    await skin.selectProfile(ms.id, "11112222333344445555666677778888");
  } catch (err) {
    msSwitch = err.message;
  }
  out("微软 selectProfile =", msSwitch);
  assert.strictEqual(msSwitch, "该账号没有可切换的角色");

  // ---------- 5. 落盘往返 ----------
  const raw = JSON.parse(await fs.readFile(path.join(root, "NaiWa", "config", "accounts.json"), "utf8"));
  const saved = raw.accounts.find((a) => a.id === yggAccount.id);
  out("\n== [8] accounts.json 里的 yggdrasil ==", saved.yggdrasil);

  // ---------- 6. refresh 失败路径 ----------
  global.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/authserver/refresh")) {
      return reply(403, { error: "ForbiddenOperationException", errorMessage: "令牌已被吊销" });
    }
    return reply(200, {});
  };
  let refreshFail = "";
  try {
    await skin.selectProfile(yggAccount.id, ID_A);
  } catch (err) {
    refreshFail = err.message;
  }
  out("\n== [9] refresh 403 的失败文案 ==", refreshFail);
  assert.strictEqual(refreshFail, "切换角色失败：HTTP 403 · 令牌已被吊销");
  assert.strictEqual((await accounts.getAccount(yggAccount.id)).uuid, ID_B, "失败时账号不能被改动");

  // ---------- 7. 衣柜里的文件直接上传（绝对路径） ----------
  const uploadCalls = [];
  global.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    uploadCalls.push({ method, url });
    return { status: 204, headers: { get: () => "application/json" }, text: async () => "" };
  };
  const wardrobeFile = path.join(dir, "青金石.png");
  await skin.uploadSkin(yggAccount.id, wardrobeFile, "classic");
  out("\n== [10] 上传衣柜文件 ==", uploadCalls);
  assert.strictEqual(uploadCalls[0].method, "PUT");
  assert.ok(uploadCalls[0].url.startsWith("https://stub.local/api/yggdrasil/api/user/profile/" + ID_B));

  // ---------- 8. 重启后仍能读回（清模块缓存从磁盘重建） ----------
  for (const key of Object.keys(require.cache)) {
    if (!key.endsWith("core\\paths.js")) delete require.cache[key];
  }
  const accounts2 = require("../dist-electron/main/auth/accounts");
  const skin2 = require("../dist-electron/main/auth/skin");
  const reloaded = await accounts2.getAccount(yggAccount.id);
  out("\n== [11] 重新加载 accounts.json 后 ==", { uuid: reloaded.uuid, name: reloaded.name, profiles: reloaded.yggdrasil.profiles });
  assert.strictEqual(reloaded.yggdrasil.profiles.length, 2, "profiles 必须能落盘读回");
  const reloadedProfiles = await skin2.listSkinProfiles(yggAccount.id);
  assert.deepStrictEqual(reloadedProfiles.map((p) => p.active), [false, true], "重启后 active 仍要按 uuid 判定");
  assert.strictEqual((await skin2.listWardrobe()).length, 2, "重启后衣柜仍是 2 条");

  console.log("\n全部断言通过 ✅");
  console.log("临时目录：" + root);
})().catch((err) => {
  console.error("\n自检失败：", err && err.stack ? err.stack : err);
  process.exit(1);
});
