// 皮肤页「正版账号只显示官方皮肤与披风」的真实渲染自检（Electron 窗口 + 内置 mock API）。
// 为什么用 Electron：仓库里没有 jsdom/playwright，SSR 又不跑 effect（拿不到官方档案），
// 只有真实浏览器环境才能验「整块不挂载」与「查询不再触发」。
// 运行：node_modules\electron\dist\electron.exe scripts\skin-premium-check.js
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const assert = require("node:assert");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");

const INDEX = path.join(__dirname, "..", "dist", "renderer", "index.html");
const MS_ACCOUNT = "acc-ms-1";
const OFFLINE_ACCOUNT = "acc-offline-1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let win;
const js = (body) => win.webContents.executeJavaScript(`(function(){${body}})()`, true);

async function waitFor(expr, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await js(`return !!(${expr});`)) return;
    await sleep(60);
  }
  throw new Error("等待超时：" + label);
}

const snapshot = () => js(`
  const q = (sel) => document.querySelectorAll(sel).length;
  const page = document.querySelector("[data-skin-page]");
  return {
    premiumFlag: page ? page.getAttribute("data-skin-premium") : "no-page",
    account: page ? (page.querySelector(".page-head select") || {}).value ?? null : null,
    // ①②④ 各自的锚点
    toolbar: q("[data-skin-toolbar]"),
    layout: q("[data-skin-layout]"),
    stage: q(".skin-stage"),
    library: q("[data-skin-library]"),
    capes: q("[data-skin-capes]"),
    applySkinBtn: q('[data-action="apply-skin"]'),
    // ③ 微软正版面版
    mojangPanel: q("[data-mojang-skin]"),
    mojangLocked: q('[data-mojang-locked="true"]'),
    mojangLoginHint: q("[data-mojang-login-hint]"),
    mojangCapeCards: q("[data-mojang-cape]"),
    mojangCapeApply: q('[data-action="mojang-cape-apply"]'),
    mojangCapeRefresh: q('[data-action="mojang-cape-refresh"]'),
    mojangCapeRemove: q('[data-action="mojang-cape-remove"]'),
    mojangCapeRemoveText: Array.from(document.querySelectorAll('[data-action="mojang-cape-remove"]')).length,
    removeText: Array.from(document.querySelectorAll("button")).filter((b) => b.textContent.trim() === "移除披风").length,
  };
`);

const selectAccount = (id) => js(`
  const sel = document.querySelector("[data-skin-page] .page-head select");
  if (!sel) return "no-select";
  sel.value = ${JSON.stringify(id)};
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return sel.value;
`);

const mockCalls = () => js("return (globalThis.__naiwaMockCalls || []).slice();");

const show = (label, data) => console.log("\n== " + label + " ==\n" + JSON.stringify(data, null, 2));

async function main() {
  win = new BrowserWindow({ show: false, width: 1360, height: 1000 });
  await win.loadFile(INDEX);

  // 首屏：导航栏出现（booted 之后才是主界面）
  await waitFor('document.querySelectorAll(".nav-item").length > 3', "主界面出现");
  await js('document.querySelectorAll(".nav-item")[3].click();');
  await waitFor('!!document.querySelector("[data-skin-page]")', "皮肤页挂载");
  await waitFor('!!(document.querySelector("[data-skin-page] .page-head select") || {}).value', "账号选择器就绪");
  await waitFor('document.querySelectorAll("[data-skin-library]").length === 1', "离线账号的本地皮肤库挂载");
  await sleep(400);

  // ---------- 1. 离线账号：①②④ 都在，正版面板退化成登录提示 ----------
  const offline = await snapshot();
  show("离线账号 (acc-offline-1)", offline);
  assert.strictEqual(await js('return document.querySelector("[data-skin-page] .page-head select").value;'), OFFLINE_ACCOUNT, "默认账号应是离线账号");
  assert.strictEqual(offline.premiumFlag, null, "离线账号不应带正版标记");
  assert.strictEqual(offline.toolbar, 1, "① data-skin-toolbar 应为 1");
  assert.strictEqual(offline.layout, 1, "② data-skin-layout 应为 1");
  assert.strictEqual(offline.library, 1, "② data-skin-library 应为 1");
  assert.strictEqual(offline.capes, 1, "④ data-skin-capes 应为 1");
  assert.strictEqual(offline.mojangPanel, 1, "③ data-mojang-skin 应为 1");
  assert.strictEqual(offline.mojangLocked, 1, "离线账号下正版面板应 locked");
  assert.strictEqual(offline.mojangLoginHint, 1, "离线账号下应有登录提示");
  assert.strictEqual(offline.mojangCapeCards, 0, "离线账号下不应有官方披风卡片");
  assert.strictEqual(offline.mojangCapeRemove, 0, "离线账号下也没有移除披风按钮");
  console.log("✔ 离线账号：①②④ 各 1 个，③ 退化成登录提示，移除披风 = 0");

  // ---------- 2. 切到微软正版：只剩 ③ ----------
  const before = (await mockCalls()).length;
  await selectAccount(MS_ACCOUNT);
  await waitFor('document.querySelectorAll("[data-mojang-cape]").length > 0', "官方披风列表读取完成");
  await sleep(900); // 留出时间：若隐藏面板仍在跑 effect，这段窗口里会露出来
  const removed = await mockCalls();
  const duringPremium = removed.slice(before);

  const premium = await snapshot();
  show("微软正版账号 (acc-ms-1)", premium);
  assert.strictEqual(premium.premiumFlag, "true", "正版账号应带 data-skin-premium");
  assert.strictEqual(premium.toolbar, 0, "① [data-skin-toolbar] 必须为 0");
  assert.strictEqual(premium.layout, 0, "② [data-skin-layout] 必须为 0");
  assert.strictEqual(premium.stage, 0, "② .skin-stage 必须为 0");
  assert.strictEqual(premium.library, 0, "② [data-skin-library] 必须为 0");
  assert.strictEqual(premium.capes, 0, "④ [data-skin-capes] 必须为 0");
  assert.strictEqual(premium.applySkinBtn, 0, "① 的应用到实例按钮必须为 0");
  assert.strictEqual(premium.mojangPanel, 1, "③ 微软正版面板必须在");
  assert.strictEqual(premium.mojangLocked, 0, "正版账号下面板不应 locked");
  assert.strictEqual(premium.mojangCapeCards, 3, "官方披风卡片应为 3 张");
  assert.strictEqual(premium.mojangCapeRemove, 0, "移除披风按钮必须为 0");
  assert.strictEqual(premium.removeText, 0, "页面上不应出现「移除披风」文案");
  console.log("✔ 正版账号：只有 ③；①②④ = 0；移除披风 = 0");

  const sideEffects = duringPremium.filter((line) => /^(skinsLocal\.list|capes\.list|accounts\.skin|skinsLocal\.import|capes\.import)/.test(line));
  console.log("切换期间的本地库调用：", sideEffects.length ? sideEffects : "（无）");
  assert.deepStrictEqual(sideEffects, [], "正版账号下本地皮肤库/披风库/账号皮肤的查询不应再触发");
  console.log("✔ 正版账号：本地库与账号皮肤的查询没有触发（列表甚至被清空）");

  // ---------- 3. 「应用」披风仍然可用 ----------
  const target = await js(`
    const btn = document.querySelector('[data-mojang-cape][data-mojang-cape-active="false"] [data-action="mojang-cape-apply"]');
    if (!btn) return null;
    const id = btn.closest("[data-mojang-cape]").getAttribute("data-mojang-cape");
    btn.click();
    return id;
  `);
  assert.ok(target, "应能找到一件可应用的披风");
  await waitFor(
    `(globalThis.__naiwaMockCalls || []).some((line) => line.indexOf("mojang.setCape") === 0 && line.indexOf(${JSON.stringify(target)}) > 0)`,
    "setCape 调用",
  );
  await waitFor(`document.querySelector('[data-mojang-cape][data-mojang-cape-active="true"]').getAttribute("data-mojang-cape") === ${JSON.stringify(target)}`, "使用中高亮切换");
  const applied = (await mockCalls()).filter((line) => line.startsWith("mojang.setCape"));
  console.log("✔ 应用披风仍可用。setCape 调用：", applied.slice(-1));
  console.log("  当前使用中：", await js('const el = document.querySelector(".skin-cape-card.is-active"); return el ? el.getAttribute("data-mojang-cape") : null;'));

  // ---------- 4. 切回离线账号：①②④ 恢复 ----------
  await selectAccount(OFFLINE_ACCOUNT);
  await waitFor('document.querySelectorAll("[data-skin-library]").length === 1', "本地皮肤库重新挂载");
  await waitFor('(document.querySelector("[data-mojang-cape]") === null)', "官方披风卡片卸载");
  await sleep(300);
  const back = await snapshot();
  show("切回离线账号", back);
  assert.strictEqual(back.premiumFlag, null, "切回离线账号后不应带正版标记");
  assert.strictEqual(back.toolbar, 1, "① 应恢复");
  assert.strictEqual(back.layout, 1, "② 应恢复");
  assert.strictEqual(back.capes, 1, "④ 应恢复");
  assert.strictEqual(back.mojangLocked, 1, "③ 应退化成登录提示");
  assert.strictEqual(back.mojangCapeRemove, 0, "移除披风按钮依然为 0");
  console.log("✔ 切回离线账号：①②④ 各恢复为 1，③ 重新变成登录提示");

  // ---------- 5. 再切回正版：再次只剩 ③ ----------
  await selectAccount(MS_ACCOUNT);
  await waitFor('document.querySelectorAll("[data-mojang-cape]").length > 0', "官方披风列表再次读取");
  await sleep(400);
  const again = await snapshot();
  assert.strictEqual(again.toolbar + again.layout + again.capes, 0, "再次切到正版账号后 ①②④ 应仍为 0");
  assert.strictEqual(again.mojangCapeRemove, 0, "移除披风按钮仍为 0");
  assert.strictEqual(again.mojangPanel, 1, "正版面板仍在");
  console.log("✔ 正版 → 离线 → 正版：DOM 数量随之变化（0 → 1 → 0）");

  // ---------- 6. 三语抽查：正版面板的文案跟着语言走 ----------
  const LANGS = ["zh-CN", "en-US", "ja-JP"];
  const rows = [];
  for (let index = 0; index < LANGS.length; index += 1) {
    await js('document.querySelectorAll(".nav-item")[13].click();');
    await waitFor('!!document.querySelector("[data-language]")', "设置页语言分段");
    await js(`document.querySelectorAll("[data-language] .segmented-item")[${index}].click();`);
    await sleep(350);
    await js('document.querySelectorAll(".nav-item")[3].click();');
    await waitFor('!!document.querySelector("[data-skin-page]")', "皮肤页重新挂载");
    await waitFor('!!(document.querySelector("[data-skin-page] .page-head select") || {}).value', "账号选择器就绪");
    await selectAccount(MS_ACCOUNT);
    await waitFor('document.querySelectorAll("[data-mojang-cape]").length > 0', "官方披风列表读取完成");
    // 正版账号下拖一个 PNG 进来：不该导入，只弹「本地皮肤库请切到离线账号」
    await js(`
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "drop-test.png", { type: "image/png" }));
      document.querySelector("[data-skin-page]").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    `);
    await sleep(350);
    const row = await js(`
      const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
      const toasts = Array.from(document.querySelectorAll(".toast-msg")).map((el) => el.textContent.trim());
      return {
        title: txt("[data-mojang-skin] .panel-title"),
        readonly: txt("[data-mojang-skin-readonly-hint]"),
        priority: txt("[data-mojang-priority-hint]"),
        dropToast: toasts.length ? toasts[toasts.length - 1] : null,
      };
    `);
    rows.push({ lang: LANGS[index], ...row });
  }
  show("三语抽查（正版账号）", rows);
  for (const row of rows) {
    for (const key of ["title", "readonly", "priority", "dropToast"]) {
      assert.ok(row[key], `${row.lang} 的 ${key} 文案缺失`);
    }
  }
  assert.strictEqual(rows[0].priority, "正版账号只显示官方皮肤与披风：要修改请去微软官网。切到离线账号可使用本地皮肤库。", "zh-CN 正版提示文案");
  assert.strictEqual(rows[1].priority, "A premium account only shows the official skin and capes — change them on the Microsoft website. Switch to an offline account to use the local skin library.", "en-US 正版提示文案");
  assert.strictEqual(rows[2].priority, "正規アカウントでは公式スキンとマントのみを表示します。変更は Microsoft の公式サイトで行ってください。ローカルスキンを使うにはオフラインアカウントに切り替えてください。", "ja-JP 正版提示文案");
  const importCalls = (await mockCalls()).filter((line) => line.startsWith("skinsLocal.import") || line.startsWith("capes.import"));
  assert.deepStrictEqual(importCalls, [], "正版账号拖放一次都没触发导入");
  console.log("✔ 三语：标题/只读说明/正版提示/拖放提示四种文案都随语言切换，且正版账号拖放不会导入");

  console.log("\n全部断言通过。");
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error("\n自检失败：", err && err.message ? err.message : err);
    app.exit(1);
  }
});
