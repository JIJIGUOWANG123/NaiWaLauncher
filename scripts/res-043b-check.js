// 0.4.3(B) 资源页三处自检：原版实例门禁 / 装实例时挑版本 / 详情页「原始页面」。
// 用法：node scripts/res-043b-check.js   （结果同时写入 scripts/.res-043b-check.log）
// 说明：本仓库没有浏览器 / jsdom 环境，所以：
//       - modKind.instanceTargetGate / needsVersionPick 与 mock/data.mockFiles 用 typescript.transpileModule
//         真跑一遍（门禁与文件列表是真执行，不是字符串匹配）；
//       - React 组件的连线（点了版本项 → installContent 带同一个 fileId）落在源码断言上。
const fs = require("node:fs");
const os = require("node:os");
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
const lineOf = (text, needle) => {
  const i = text.indexOf(needle);
  return i < 0 ? -1 : text.slice(0, i).split("\n").length;
};

const mods = read("src/renderer/pages/ModsPage.tsx");
const modKindSrc = read("src/renderer/lib/modKind.ts");
const panel = read("src/renderer/components/ModDetailPanel.tsx");
const css = read("src/renderer/css/mods.css");
const i18nExtra = read("src/renderer/lib/i18n-extra.ts");

// ---------- 0) 编译期门槛由外层 tsc 给出 ----------
say("=== 0) tsc -p tsconfig.web.json --noEmit 由外层命令给出（本脚本只看行为） ===");
say("");

// ---------- 1) 原版实例门禁：真跑 instanceTargetGate ----------
const ts = require(path.join(root, "node_modules", "typescript"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mk-"));
const transpile = (src, file) => {
  fs.writeFileSync(file, ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
transpile(modKindSrc, path.join(tmp, "modKind.js"));
fs.writeFileSync(path.join(tmp, "format.js"), "exports.loaderLabel = (v) => v;\n");
const mk = require(path.join(tmp, "modKind.js"));

say("=== 1) 弹窗里原版实例项（modKind.instanceTargetGate 实跑） ===");
const gateOf = (kind, loader) => mk.instanceTargetGate(kind, loader);
const matrix = [["mod", "vanilla"], ["shader", "vanilla"], ["resourcepack", "vanilla"], ["modpack", "vanilla"]];
for (const [kind, loader] of matrix) {
  const g = gateOf(kind, loader);
  say("    " + kind.padEnd(13) + "+ " + loader.padEnd(8) + " → allowed=" + g.allowed + " reason=" + (g.reasonKey || "-"));
}
ok(gateOf("mod", "vanilla").allowed === false && !!gateOf("mod", "vanilla").reasonKey,
  "模组 × 原版实例：置灰且给原因", gateOf("mod", "vanilla").reasonKey);
ok(gateOf("shader", "vanilla").allowed === false && !!gateOf("shader", "vanilla").reasonKey,
  "光影 × 原版实例：置灰且给原因", gateOf("shader", "vanilla").reasonKey);
ok(gateOf("resourcepack", "vanilla").allowed === true && gateOf("resourcepack", "vanilla").reasonKey === null,
  "资源包 × 原版实例：不禁用（原版能用资源包）");
ok(gateOf("modpack", "vanilla").allowed === true && gateOf("modpack", "vanilla").reasonKey === null,
  "整合包 × 原版实例：不禁用（本来就是新建实例）");
ok(gateOf("mod", "fabric").allowed === true && gateOf("mod", "forge").allowed === true,
  "带加载器的实例不受影响（fabric / forge 可选）");
// 弹窗里那一项真的用了这个门禁
const optBlock = mods.slice(mods.indexOf("{instances.map((instance) => {"), mods.indexOf("data-target-option-kind=\"server\""));
const has = (text, needle) => text.includes(needle);
ok(has(optBlock, "const gate = instanceTargetGate(kind, instance.loader);"), "实例项按 instanceTargetGate(kind, instance.loader) 判门禁",
  "ModsPage.tsx:" + lineOf(mods, "const gate = instanceTargetGate(kind, instance.loader);"));
ok(has(optBlock, 'data-target-option-disabled={blocked ? "1" : "0"}') && has(optBlock, "disabled={blocked}"),
  "置灰项写 data-target-option-disabled=1 且真的 disabled");
ok(has(optBlock, '<span className="target-option-reason">{reason}</span>'), "置灰项把原因写在副标下面（可见文案，不靠 hover）");
ok(/data-target-modal-vanilla-hint/.test(mods) && /pages\.mods\.targetModalVanillaHint/.test(mods),
  "一个带加载器的实例都没有时提示先去建（data-target-modal-vanilla-hint）");
ok(/onClick=\{\(\) => void pickTargetInstance\(targetModal\.mod, instance, targetModal\.file\)\}/.test(optBlock),
  "点可用实例项 = pickTargetInstance（带文件就直接装，不带文件进第二步）");
say("");

// ---------- 2) 卡片按钮：选中原版实例 + 模组 → 置灰 ----------
say("=== 2) 卡片安装按钮（ModsPage.tsx:" + lineOf(mods, "data-install-blocked") + "） ===");
const gateLine = lineOf(mods, "const instanceGate = currentInstance && !serverTarget");
const blockedLine = lineOf(mods, "const instanceBlocked = instanceGate !== null && !instanceGate.allowed;");
const hintLine = lineOf(mods, "const instanceBlockHint");
const titleLine = lineOf(mods, "const installTargetTitle = instanceBlockHint");
say("    实例门禁（ModsPage.tsx:" + gateLine + "）: currentInstance && !serverTarget → instanceTargetGate(kind, currentInstance.loader)");
say("    置灰标记（ModsPage.tsx:" + blockedLine + "）: instanceBlocked");
say("    原因文案（ModsPage.tsx:" + hintLine + "）: instanceBlockHint = tr(instanceGate.reasonKey)");
say("    title 优先级（ModsPage.tsx:" + titleLine + "）: installTargetTitle = instanceBlockHint ?? serverBlockHint ?? …");
const cardStart = mods.indexOf("data-install-target={key}");
const cardBlock = mods.slice(cardStart, cardStart + mods.slice(cardStart).indexOf("</button>"));
ok(/const instanceGate = currentInstance && !serverTarget\s*\n?\s*\? instanceTargetGate\(kind, currentInstance\.loader\)/.test(mods),
  "侧栏选中的实例参与判定（currentInstance.loader）", "gate 在 ModsPage.tsx:" + gateLine);
ok(/data-install-blocked=\{instanceBlocked \? "1" : undefined\}/.test(cardBlock), "卡片按钮带 data-install-blocked（ModsPage.tsx:" + lineOf(mods, "data-install-blocked") + "）");
ok(/disabled=\{pluginBusyKey === key \|\| instanceBlocked\}/.test(cardBlock), "卡片按钮在原版实例 + 模组/光影时 disabled");
ok(/disabled=\{pluginBusyKey === key \|\| instanceBlocked\}/.test(cardBlock) && /title=\{installTargetTitle\}/.test(cardBlock),
  "禁用同时仍有 title（installTargetTitle 把 instanceBlockHint 排在第一位）");
ok(/const installTargetTitle = instanceBlockHint \?\? serverBlockHint \?\?/.test(mods), "title 先给门禁原因，再给目标名");
ok(/title=\{instanceBlockHint \?\? serverBlockHint \?\?/.test(mods) === false, "（卡片按钮用的是 installTargetTitle，不是内联三元）");
// 没选实例时按钮仍可点：弹窗里那一项才是灰的
ok(!/disabled=\{instanceBlocked \|\| /.test(cardBlock), "instanceBlocked 只在有实例时成立（没有实例 = 照常弹窗）");
say("");

// ---------- 3) 选实例 → 第二步挑版本 ----------
say("=== 3) 版本选择（ModsPage.tsx:" + lineOf(mods, "data-target-version-list") + "） ===");
const versionStep = mods.slice(mods.indexOf("data-target-version-step"), mods.indexOf("{targetGroups.map((group) => ("));
ok(/data-target-version-list/.test(versionStep), "第二步有 data-target-version-list");
ok(/data-target-version-file=\{file\.fileId\}/.test(versionStep), "每一项带 data-target-version-file={file.fileId}");
ok(/data-target-version-back/.test(mods) && /pages\.mods\.targetVersionBack/.test(mods), "有「上一步」按钮 data-target-version-back");
ok(/setTargetModal\(\{ mod: targetModal\.mod, file: targetModal\.file \}\)/.test(mods), "「上一步」回到选目标那一步（保留已选实例的文件）");

// 文件列表请求：按目标实例的 MC 版本 + 加载器
const reqBlock = mods.slice(mods.indexOf("const targetVersions = useAsync<ModFileInfo[]>"), mods.indexOf("const installedRefs = useAsync"));
ok(/gameVersion: modal\.instance\.mcVersion/.test(reqBlock) && /loader: modal\.instance\.loader/.test(reqBlock),
  "文件请求按该实例的 MC 版本 + 加载器（api.mods.files）");
ok(/kind: detailKind/.test(reqBlock), "文件请求带 kind（光影/资源包走各自目录）");

// mock 的文件列表：项数 > 0（真跑 mockFiles）
transpile(read("src/renderer/mock/data.ts"), path.join(tmp, "data.js"));
const data = require(path.join(tmp, "data.js"));
const project = { provider: "modrinth", projectId: "abc", slug: "sodium", title: "Sodium Extra", downloads: 1000 };
const fileList = data.mockFiles(project, "1.21.4", "fabric", "mod");
const fileCount = (mods.match(/versionFiles\.map\(\(file\) =>/) || []).length;
say("    mockFiles(mod, 1.21.4, fabric) → " + fileList.length + " 项，首项 fileId=" + fileList[0].fileId);
ok(fileList.length > 0, "版本列表项数 > 0（mock 真跑 " + fileList.length + " 项）");
ok(fileCount === 1, "列表按 versionFiles.map 渲每一项（每项一个 data-target-version-file）");

// 点某一项 → installContent 的 fileId 就是该项（三跳都在源码里）
const pickIdx = mods.indexOf("const pickTargetVersion");
const pickBlock = mods.slice(pickIdx, pickIdx + 600);
ok(/onClick=\{\(\) => void pickTargetVersion\(targetModal\.mod, versionInstance, file\)\}/.test(versionStep),
  "点某项 → pickTargetVersion(mod, instance, 该项 file)", "ModsPage.tsx:" + lineOf(mods, "pickTargetVersion(targetModal.mod, versionInstance, file)"));
ok(/await installContent\(mod, instance, file\)/.test(pickBlock), "pickTargetVersion → installContent(mod, instance, file)", "ModsPage.tsx:" + lineOf(mods, "await installContent(mod, instance, file);"));
ok(/fileId: file\?\.fileId \?\? null/.test(mods), "installContent 把 file.fileId 原样带进安装队列（fileId 等于点击那一项）",
  "ModsPage.tsx:" + lineOf(mods, "fileId: file?.fileId ?? null"));
ok(/fileName: file\?\.fileName \?\? ""/.test(mods), "文件名同一条链路（安装条目显示的就是点的那一项）");

// 空列表 / 请求失败 → 退回 file=null
const fbIdx = mods.indexOf("versionFallbackRef.current = key;");
const fbBlock = mods.slice(fbIdx, fbIdx + 300);
ok(fbIdx > 0 && /void pickTargetVersion\(modal\.mod, modal\.instance, null\)/.test(fbBlock),
  "列表空或请求失败 → 退回 file=null 的自动挑最新", "ModsPage.tsx:" + lineOf(mods, "void pickTargetVersion(modal.mod, modal.instance, null);"));
ok(/push\(tr\("pages\.mods\.targetVersionFallback"\), "info"\)/.test(fbBlock), "退回时 toast 说明原因");
ok(/if \(!targetVersions\.error && \(targetVersions\.data \?\? \[\]\)\.length > 0\) return;/.test(mods), "只有空列表/失败才退回（有文件就不打扰）");
ok(/data-target-version-fallback-hint/.test(mods), "空列表时页面也写出这句说明（data-target-version-fallback-hint）");
ok(/if \(file === null && needsVersionPick\(detailKind\)\)/.test(mods), "已经带了文件（详情面板某一行）就跳过第二步，保持旧行为");
const nv = ["mod", "shader", "resourcepack", "modpack", "plugin"].map((k) => [k, mk.needsVersionPick(k)]);
say("    needsVersionPick 实跑: " + nv.map(([k, v]) => k + "=" + v).join(", "));
ok(mk.needsVersionPick("mod") && mk.needsVersionPick("shader") && mk.needsVersionPick("resourcepack"), "模组/光影/资源包选实例后都挑版本");
ok(!mk.needsVersionPick("modpack") && !mk.needsVersionPick("plugin"), "整合包（新建实例）与插件（服务端目录）没有这一步");
say("");

// ---------- 4) 详情页「原始页面」 ----------
say("=== 4) 详情页「原始页面」（ModDetailPanel.tsx:" + lineOf(panel, "data-action=\"open-source-page\"") + "） ===");
const srcIdx = panel.indexOf('data-action="open-source-page"');
const mcmodIdx = panel.indexOf('data-action="mcmod-search"');
say("    data-action=\"open-source-page\" 在 ModDetailPanel.tsx:" + lineOf(panel, 'data-action="open-source-page"')
  + "，data-action=\"mcmod-search\" 在 " + lineOf(panel, 'data-action="mcmod-search"'));
ok(srcIdx >= 0 && mcmodIdx >= 0 && srcIdx < mcmodIdx, "DOM 顺序：「原始页面」在 MCMOD 搜索左边");
const srcBtn = panel.slice(srcIdx - 400, srcIdx + 500);
ok(/data-source-url=\{sourceUrl\}/.test(srcBtn), "按钮带 data-source-url={sourceUrl}");
ok(/onClick=\{\(\) => void openSourcePage\(\)\}/.test(srcBtn), "点击走 openSourcePage()");
const openIdx = panel.indexOf("const openSourcePage = async () =>");
const openBlock = panel.slice(openIdx, openIdx + 300);
ok(/await api\.app\.openExternal\(sourceUrl\)/.test(openBlock), "openExternal 的 URL 就是 sourceUrl", "ModDetailPanel.tsx:" + lineOf(panel, "await api.app.openExternal(sourceUrl)"));
ok(/\{sourceUrl \? \(\s*<button/.test(panel.slice(srcIdx - 600, srcIdx + 40)) || /\{sourceUrl \? \(/.test(panel),
  "sourceUrl 为空时不渲染这个按钮（{sourceUrl ? (…) : null}）");
ok(/pages\.modDetail\.openSourcePage/.test(panel) && /mod-detail-source/.test(panel), "按钮文案与样式类都在（mod-detail-source）");
ok(/\.mod-detail-source\s*\{/.test(css) && /@media \(max-width: 900px\)[\s\S]*\.mod-detail-source-label\s*\{\s*display: none;/.test(css),
  "窄宽度只留图标（与 MCMOD 同一套 CSS）");
ok(/headActions = data \? \(/.test(panel), "头部动作只在详情拿到之后渲染（两个按钮共用这个闸门）");
say("");

// ---------- 5) i18n 三语抽查 ----------
say("=== 5) i18n 三语（i18n-extra.ts） ===");
const triple = (key, text) => {
  const i = text.indexOf('"' + key + '": D(');
  if (i < 0) return null;
  const seg = text.slice(i + key.length + 6, i + key.length + 900);
  const m = seg.match(/^\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/);
  return m ? [m[1], m[2], m[3]] : null;
};
for (const key of ["pages.mods.instanceVanillaBlocked", "pages.mods.targetVersionBack", "pages.modDetail.openSourcePage"]) {
  const tr = triple(key, i18nExtra);
  ok(!!tr && tr.every((s) => s.length > 0), "三语齐全：" + key, tr ? JSON.stringify(tr) : "缺失");
}
for (const key of [
  "pages.mods.targetModalVanillaHint", "pages.mods.targetVersionTo", "pages.mods.targetVersionFallback",
  "pages.modDetail.openSourcePageHint",
]) {
  const tr = triple(key, i18nExtra);
  ok(!!tr && tr.every((s) => s.length > 0), "新增词条三语齐全：" + key, tr ? JSON.stringify(tr).slice(0, 110) : "缺失");
}
ok(/pages\.modDetail\.openSourcePage\": D\("原始页面", "Original page", "配布ページ"\)/.test(i18nExtra),
  "「原始页面」三语照需求（原始页面 / Original page / 配布ページ）");
say("");

say(failed === 0 ? "ALL PASS (" + out.filter((l) => l.startsWith("PASS")).length + " 项)" : "FAILED: " + failed);
fs.writeFileSync(path.join(root, "scripts", ".res-043b-check.log"), out.join("\n") + "\n", "utf8");
console.log(out.join("\n"));
process.exit(failed === 0 ? 0 : 1);
