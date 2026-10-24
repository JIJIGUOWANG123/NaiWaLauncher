// 0.4.5(B) 自检：整合包直装新实例 / 关于页板块重排 / 五个启动器致谢 / 去掉「推荐：」前缀。
// 用法：node scripts/about-modpack-045b-check.js  （结果同时写入 scripts/.about-modpack-045b-check.log）
// 说明：仓库没有浏览器 / jsdom 运行环境，所以断言分两类：
//   1) 源码顺序 / JSX 结构断言（关于页 DOM 顺序、致谢条目、data 属性）；
//   2) 把 ModsPage.tsx 里 installModpackAndCreate、卡片 onClick、详情面板 onInstall 的**真实源码**
//      抽出来配桩真跑，断言的是调用结果，不是字符串匹配。
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const out = [];
const say = (line = "") => out.push(line);
let failed = 0;
const ok = (cond, msg, detail) => {
  if (!cond) { failed += 1; say("FAIL " + msg + (detail ? " :: " + detail : "")); return; }
  say("PASS " + msg + (detail ? " :: " + detail : ""));
};

const mods = read("src/renderer/pages/ModsPage.tsx");
const about = read("src/renderer/pages/AboutPage.tsx");
const i18n = read("src/renderer/lib/i18n.ts");
const extra = read("src/renderer/lib/i18n-extra.ts");

// ---------- 抽取工具 ----------
const braceBlock = (text, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
  }
  return null;
};
const bodyAfter = (text, marker) => {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const open = text.indexOf("{", at + marker.length);
  return open < 0 ? null : braceBlock(text, open);
};
const tripleOf = (text, key) => {
  const at = text.indexOf('"' + key + '": D(');
  if (at < 0) return null;
  const m = text.slice(at + key.length + 6, at + key.length + 1200)
    .match(/^\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/);
  return m ? { zh: m[1], en: m[2], ja: m[3] } : null;
};

// ---------- B① 整合包卡片：不弹目标弹窗，直接建实例 ----------
say("=== B① 整合包卡片点击 → 直接「安装并创建实例」（桩调用） ===");
const sideStart = mods.indexOf('{isModpack ? (');
const sideEnd = mods.indexOf('{serverTarget && !pluginServer ? (', sideStart);
ok(sideStart > 0 && sideEnd > sideStart, "卡片侧栏 JSX 片段已定位");
const packJsx = mods.slice(sideStart, sideEnd);
ok(packJsx.includes('data-install-modpack-new="1"'), "卡片按钮带 data-install-modpack-new=\"1\"");
ok(packJsx.includes("onClick={() => void installModpackAndCreate(mod)}"),
  "卡片按钮 onClick 直接调 installModpackAndCreate(mod)");
ok(!packJsx.includes("setTargetModal"), "卡片按钮不再碰 setTargetModal（不弹「安装到…」）");
ok(!packJsx.includes("setPackConfirm"), "卡片按钮也不再走整合包确认框");

// installModpackAndCreate 真实函数体 + 桩
const packBody = bodyAfter(mods, "const installModpackAndCreate = (mod: ModSearchResult, fileId?: string) =>");
ok(!!packBody, "installModpackAndCreate 函数体已抽到");
const packCalls = [];
const runInstallModpack = new Function("setTargetModal", "enqueueInstall", "installKeyOf", "keyOf", "titleOf",
  "return function installModpackAndCreate(mod, fileId) {" + packBody + "};")(
  (...args) => packCalls.push(["setTargetModal", ...args]),
  (entry) => packCalls.push(["enqueueInstall", entry]),
  (provider, projectId, fileId, instanceId) => [provider, projectId, fileId, instanceId].join("|"),
  (mod) => mod.provider + ":" + mod.projectId,
  (mod) => mod.title,
);
const packMod = { provider: "modrinth", projectId: "FO1a", title: "Fabulously Optimized" };
runInstallModpack(packMod);
const enq = packCalls.find((c) => c[0] === "enqueueInstall");
ok(packCalls[0][0] === "setTargetModal" && packCalls[0][1] === null, "先关掉目标弹窗（setTargetModal(null)）",
  JSON.stringify(packCalls[0]));
ok(!!enq, "走的是现有 installModpack / createInstance 队列（enqueueInstall 被调用）");
ok(enq && enq[1].kind === "modpack", "队列条目 kind = modpack", enq && enq[1].kind);
ok(enq && enq[1].instanceId === "" && enq[1].instanceName === "",
  "队列条目不带实例（instanceId / instanceName 为空 → 主进程新建实例）",
  enq && JSON.stringify({ id: enq[1].instanceId, name: enq[1].instanceName }));
ok(enq && enq[1].projectKey === "modrinth:FO1a", "队列条目指向该整合包工程", enq && enq[1].projectKey);
ok(!mods.includes("packConfirm") && !mods.includes("pages.mods.modpackConfirmTitle"),
  "整合包确认弹窗已彻底移除（没有 packConfirm 残留）");

// 详情面板按钮：modpack 也直接建实例
say("");
const detailBody = bodyAfter(mods, "onInstall={() =>");
ok(!!detailBody, "详情面板 onInstall 处理体已抽到");
const detailCalls = [];
const runDetail = new Function("detailKind", "setTargetModal", "installModpackAndCreate", "selected", "sortedFiles",
  "return function onInstall() {" + detailBody + "};")(
  "modpack",
  (v) => detailCalls.push(["setTargetModal", v]),
  (m) => detailCalls.push(["installModpackAndCreate", m]),
  packMod,
  [{ fileId: "f1" }],
);
runDetail();
ok(detailCalls.length === 1 && detailCalls[0][0] === "installModpackAndCreate" && detailCalls[0][1] === packMod,
  "详情面板按钮（kind=modpack）→ 只调 installModpackAndCreate，不弹目标弹窗",
  JSON.stringify(detailCalls.map((c) => c[0])));

// ---------- B② 侧栏「安装目标」在整合包下禁用 ----------
say("");
say("=== B② 侧栏目标选择器：modpack 下 disabled + title ===");
const selectAt = mods.indexOf("data-target-select");
const selectBlock = mods.slice(selectAt, mods.indexOf("</select>", selectAt));
ok(mods.slice(Math.max(0, selectAt - 400), selectAt).includes('className="select-wrap"'), "目标选择器容器仍在（data-target-select）");
ok(selectBlock.includes("disabled={isModpack}"), "select 上 disabled={isModpack}");
ok(selectBlock.includes('title={isModpack ? tr("pages.mods.modpackTargetDisabled") : undefined}'),
  "select 上有 title 说明（modpack 时给出原因）");
ok(selectBlock.includes('data-target-disabled={isModpack ? "1" : undefined}')
  || mods.slice(selectAt - 200, selectAt + 200).includes('data-target-disabled={isModpack ? "1" : undefined}'),
  "容器上带 data-target-disabled（自检用）");
const disabledTitle = tripleOf(extra, "pages.mods.modpackTargetDisabled");
ok(!!disabledTitle, "禁用理由词条 pages.mods.modpackTargetDisabled 存在");
ok(disabledTitle && /整合包.*新建实例.*不需要目标/.test(disabledTitle.zh),
  "中文禁用理由包含「整合包 / 新建实例 / 不需要目标」", disabledTitle && disabledTitle.zh);
// disabled={isModpack} 的求值：modpack → true，其它类型 → false
const disabledExpr = selectBlock.match(/disabled=\{([^}]+)\}/);
const evalDisabled = (kind) => new Function("isModpack", "return Boolean(" + disabledExpr[1] + ");")(kind === "modpack");
ok(evalDisabled("modpack") === true, "kind=modpack → 选择器 disabled=true");
ok(evalDisabled("mod") === false && evalDisabled("shader") === false && evalDisabled("resourcepack") === false,
  "kind=mod / shader / resourcepack → 选择器仍可用");

// ---------- B③ 关于页板块顺序 ----------
say("");
say("=== B③ 关于页 DOM 顺序（源码中的兄弟节点顺序） ===");
const orderMarks = [
  ["news", 'className="about-news"'],
  ["capabilities", 'className="about-cards"'],
  ["changelog", "data-about-changelog"],
  ["team", "data-about-team"],
  ["thanks", "data-about-thanks"],
];
// 只在 JSX 区里找标记：文件顶部的数据注释里也提到过这些 data 属性名
const jsxStart = about.indexOf('<section className="page about-page">');
const at = (marker) => (about.indexOf(marker, jsxStart) < 0 ? -1 : about.indexOf(marker, jsxStart));
const order = orderMarks.map(([name, marker]) => [name, at(marker)])
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name);
say("    顺序数组 = " + JSON.stringify(order));
ok(JSON.stringify(order) === JSON.stringify(["news", "capabilities", "changelog", "team", "thanks"]),
  "news → capabilities → changelog → team → thanks", JSON.stringify(order));
ok(orderMarks.every(([, m]) => at(m) > 0), "五个板块标记都能在 JSX 里找到");
ok(at("data-about-thanks") > at("data-about-team"), "链接与致谢排在核心团队之后");
ok(at("data-changelog-scope") < at("data-about-team"), "更新日志正文（data-changelog-scope）在核心团队之前");
ok(jsxStart > 0, "关于页 JSX 起点已定位（顺序断言只在渲染区里做）");

// ---------- B④ 致谢项数与五个新条目 ----------
say("");
say("=== B④ 致谢网格：13 + 5 = 18，新五项 item / url / img ===");
const thanksStart = about.indexOf("const THANKS: ThanksEntry[] = [");
const thanksBody = about.slice(thanksStart, about.indexOf("\n];", thanksStart));
const entryRe = /\{ key: "([a-z0-9]+)",[^}]*?url: ([A-Z0-9_]+) \}/g;
const entries = [];
let m;
while ((m = entryRe.exec(thanksBody))) entries.push({ key: m[1], urlConst: m[2] });
const imageRe = /\{ key: "([a-z0-9]+)",[^}]*?image: brand([A-Za-z0-9]+)/g;
const imageOf = {};
let im;
while ((im = imageRe.exec(thanksBody))) imageOf[im[1]] = im[2];
ok(entries.length === 18, "致谢条目数 = 18（原 13 + 新增 5）", "实际 " + entries.length);
const urlConst = (name) => {
  const hit = about.match(new RegExp('const ' + name + ' = "([^"]+)";'));
  return hit ? hit[1] : null;
};
const expected = [
  ["molaunch", "https://molaunch.moiu.cn/"],
  ["xmcl", "https://xmcl.app/zh/"],
  ["axlmc", "https://axlmc.org/"],
  ["oaoi", "https://mc.oaoi.cn/"],
  ["bakaxl", "https://www.bakaxl.com/"],
];
for (const [key, url] of expected) {
  const entry = entries.find((e) => e.key === key);
  ok(!!entry, "致谢项存在：" + key);
  ok(entry && urlConst(entry.urlConst) === url, key + " url = " + url, entry && urlConst(entry.urlConst));
  const brandFile = imageOf[key] ? imageOf[key].toLowerCase() : null;
  ok(brandFile === key, key + " 用本地图标 assets/brand/" + key + ".png", brandFile);
  const png = fs.readFileSync(path.join(root, "src/renderer/assets/brand/" + key + ".png"));
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  ok(w > 0 && h === w, key + ".png 是方形图标（" + w + "×" + h + "）");
}
const brandImports = expected.map(([key]) => about.includes('import brand' + key[0].toUpperCase() + key.slice(1) + ' from "../assets/brand/' + key + '.png";'));
ok(brandImports.every(Boolean), "五个图标都是 import 进来的本地 png（不联网重抓）", JSON.stringify(brandImports));
const launcherHint = tripleOf(extra, "pages.about.thanks.launcherHint");
ok(launcherHint && launcherHint.zh === "同类启动器", "副标题「同类启动器」三语词条存在", launcherHint && launcherHint.zh);

// ---------- B⑤ Steamcommunity 302 不再有「推荐：」 ----------
say("");
say("=== B⑤ Steamcommunity 302 标题不再含「推荐」 ===");
const baseTitle = tripleOf(i18n, "about.link.steam302");
ok(!!baseTitle && baseTitle.zh.includes("推荐"), "i18n.ts 里仍是「推荐：Steamcommunity 302」（被覆盖前）", baseTitle && baseTitle.zh);
const override = tripleOf(extra, "about.link.steam302");
ok(!!override, "i18n-extra.ts 用同名 key 覆盖 about.link.steam302");
// DICT 合并顺序：Object.assign(DICT, pagesDict, pagesDictExtra) → 后者生效
ok(i18n.indexOf("Object.assign(DICT, pagesDict, pagesDictExtra)") > 0, "合并顺序确认：i18n-extra 在后、覆盖生效");
const effective = override || baseTitle;
for (const lang of ["zh", "en", "ja"]) {
  ok(effective && !/推荐|おすすめ|Recommended/.test(effective[lang]),
    "生效标题（" + lang + "）不含推荐前缀", effective && effective[lang]);
}
ok(effective && effective.zh === "Steamcommunity 302", "中文标题 = Steamcommunity 302", effective && effective.zh);

// ---------- B⑥ 三语抽查 ----------
say("");
say("=== B⑥ 三语抽查 3 条 ===");
for (const key of ["pages.mods.modpackTargetDisabled", "pages.about.thanks.launcherHint", "about.link.steam302"]) {
  const t = tripleOf(extra, key);
  ok(!!t, key + " 在 i18n-extra.ts 里有词条");
  if (t) say("    " + key + " → zh=" + t.zh + " | en=" + t.en + " | ja=" + t.ja);
  ok(!!t && !!(t.zh && t.en && t.ja), key + " 三语齐全");
}
for (const key of ["pages.about.thanks.molaunch", "pages.about.thanks.xmcl", "pages.about.thanks.axlmc",
  "pages.about.thanks.oaoi", "pages.about.thanks.bakaxl"]) {
  const t = tripleOf(extra, key);
  ok(!!t && t.zh === t.en && t.zh === t.ja, key + " 三语同名（品牌名不翻译）", t && t.zh);
}

say("");
say(failed === 0 ? "ALL PASS (" + out.filter((l) => l.startsWith("PASS ")).length + " 项)" : failed + " 项 FAIL");
const log = out.join("\n") + "\n";
fs.writeFileSync(path.join(__dirname, ".about-modpack-045b-check.log"), log, "utf8");
process.stdout.write(log);
process.exit(failed === 0 ? 0 : 1);
