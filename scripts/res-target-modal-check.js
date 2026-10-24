// 0.4.1(A) 资源页「安装到…」弹窗 + 每页 10 条（2 列 × 5 行）自检。
// 用法：node scripts/res-target-modal-check.js   （结果同时写入 scripts/.res-target-modal-check.log）
// 说明：本仓库没有浏览器 / jsdom 运行环境，所以 DOM 断言与 CSS 计算值都落在源码与样式表的解析上：
//       - modKind.ts 用 typescript.transpileModule 真跑一遍（分组与能力门禁是真执行，不是字符串匹配）；
//       - CSS 用一个小级联解析器按视口宽度算出 .res-grid 的 grid-template-columns。
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
const css = read("src/renderer/css/mods.css");
const i18nExtra = read("src/renderer/lib/i18n-extra.ts");
const i18nPages = read("src/renderer/lib/i18n-pages.ts");

// ---------- 1) modKind：分组与门禁是真跑出来的 ----------
const ts = require(path.join(root, "node_modules", "typescript"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "modkind-"));
fs.writeFileSync(path.join(tmp, "modKind.js"), ts.transpileModule(modKindSrc, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText);
fs.writeFileSync(path.join(tmp, "format.js"), "exports.loaderLabel = (value) => value;\n");
const mk = require(path.join(tmp, "modKind.js"));

say("=== 1) 分组归属（modKind.targetGroupsOf 实跑） ===");
for (const kind of ["mod", "plugin", "modpack", "resourcepack", "shader"]) {
  const groups = mk.targetGroupsOf(kind);
  say("    " + kind.padEnd(13) + " → [" + groups.join(", ") + "]");
}
ok(JSON.stringify(mk.targetGroupsOf("mod")) === JSON.stringify(["instance", "server"]), "模组：实例组 + 服务端组都在");
ok(JSON.stringify(mk.targetGroupsOf("plugin")) === JSON.stringify(["server"]), "插件：只有服务端组（没有实例项）");
for (const kind of ["modpack", "resourcepack", "shader"]) {
  ok(JSON.stringify(mk.targetGroupsOf(kind)) === JSON.stringify(["instance"]), kind + "：只有实例组（服务端组不出现）");
}

say("");
say("=== 2) 能力门禁（modKind.serverTargetGateFor 实跑） ===");
const gateOf = (kind, core) => mk.serverTargetGateFor(kind, mk.serverCapabilitiesOf(core));
const rows = [["mod", "paper"], ["mod", "fabric"], ["plugin", "paper"], ["plugin", "forge"]];
for (const [kind, core] of rows) {
  const g = gateOf(kind, core);
  say("    " + kind.padEnd(6) + " → " + core.padEnd(7) + " allowed=" + g.allowed + " reason=" + (g.reasonKey || "-"));
}
ok(gateOf("mod", "paper").allowed === false, "模组装插件服：置灰（有原因）", gateOf("mod", "paper").reasonKey);
ok(gateOf("mod", "fabric").allowed === true, "模组装模组服：可选");
ok(gateOf("plugin", "paper").allowed === true, "插件装插件服：可选");
ok(gateOf("plugin", "forge").allowed === false, "插件装模组服：置灰（有原因）", gateOf("plugin", "forge").reasonKey);
ok(gateOf("shader", "paper").allowed === false, "光影装服务端：置灰（有原因）", gateOf("shader", "paper").reasonKey);

// ---------- 3) 弹窗 DOM 结构（源码断言） ----------
say("");
say("=== 3) 「安装到…」弹窗（ModsPage.tsx:" + lineOf(mods, "data-target-modal data-target-modal-kind") + "） ===");
const modalStart = mods.indexOf("{targetModal ? (");
const modal = mods.slice(modalStart, mods.indexOf("</Modal>", modalStart));
ok(modal.length > 0, "弹窗容器有 data-target-modal + data-target-modal-kind");
ok(/^\{targetModal \? \(\s*<Modal[\s\S]*?title=\{tr\("pages\.mods\.targetModalTitle"\)\}/.test(modal), "弹窗用的是 components/Modal.tsx 的 Modal，标题 pages.mods.targetModalTitle");
ok(/targetGroups\.map\(\(group\)/.test(modal), "分组由 targetGroups 渲染（模组两组 / 插件只服务端 / 其它只实例）");
ok(/data-target-modal-group=\{group\}/.test(modal), "每组有 data-target-modal-group=\"instance|server\"");
ok(/data-target-option\b/.test(modal) && /data-target-option-kind="instance"/.test(modal) && /data-target-option-kind="server"/.test(modal), "每项都有 data-target-option + data-target-option-kind");
ok(/data-target-option-id=\{instance\.id\}/.test(modal) && /data-target-option-id=\{entry\.meta\.id\}/.test(modal), "每项都有 data-target-option-id");
ok((modal.match(/data-target-option-disabled=/g) || []).length === 2, "每项都有 data-target-option-disabled（实例 / 服务端各一处）");
ok(/data-target-option-disabled=\{busy \? "1" : "0"\}/.test(modal), "实例项：安装中的那项标记 disabled=1");
ok(/data-target-option-disabled=\{gate\.allowed \? "0" : "1"\}/.test(modal), "服务端项：按能力门禁标记 disabled");
ok(/disabled=\{!gate\.allowed\}/.test(modal) && /title=\{!gate\.allowed && reason \? reason : meta\}/.test(modal), "服务端置灰项真的 disabled 且 title 给原因");
ok(/disabled=\{busy\}/.test(modal) && /target-option-reason/.test(modal), "实例置灰项 disabled 且写出原因文案");
ok(/data-target-modal-browse/.test(modal) && /pages\.mods\.browseOnly/.test(modal), "底部有「不安装，仅浏览」（pages.mods.browseOnly）");
ok(/data-target-modal-cancel/.test(modal) && /pages\.common\.cancel/.test(modal), "底部有「取消」（pages.common.cancel，三语已有）");
ok(/data-target-modal-note/.test(modal) && /pages\.mods\.serverTargetUnsupported/.test(modal), "只能装实例的类型：服务端组不出现，带原因说明");
ok(/onClick=\{\(\) => void pickTargetInstance\(targetModal\.mod, instance, targetModal\.file\)\}/.test(modal), "点实例项 = 选中并安装到该实例");
ok(/onClick=\{\(\) => void pickTargetServer\(targetModal\.mod, entry, targetModal\.file\)\}/.test(modal), "点服务端项 = 校验门禁后安装到该服务端");

// ---------- 4) 入口：卡片按钮 / 详情面板 ----------
say("");
say("=== 4) 安装入口（ModsPage.tsx:" + lineOf(mods, "data-install-target={key}") + "） ===");
const cardBtn = mods.slice(mods.indexOf("data-install-target={key}"));
const cardBtnBlock = cardBtn.slice(0, cardBtn.indexOf("</button>"));
// 0.4.2(D) 起：有目标就直接装，没目标才弹窗（详见 scripts/res-target-direct-check.js）。
ok(/aria-haspopup=\{installTarget === null \? "dialog" : undefined\}/.test(cardBtnBlock), "卡片按钮只在没目标时 aria-haspopup=dialog（有目标直装，不是行内菜单）");
ok(/onClick=\{\(\) => void installFromCard\(mod\)\}/.test(cardBtnBlock), "卡片按钮点击 = installFromCard（有目标直装 / 没目标开弹窗）");
ok(!/disabled=\{[^}]*noInstance[^}]*\}/.test(cardBtnBlock) && /disabled=\{pluginBusyKey === key\}/.test(cardBtnBlock), "卡片按钮只在安装中禁用（没选目标也能点）");
ok(/installTargetLabel/.test(cardBtnBlock), "卡片按钮文案来自 installTargetLabel");
ok(/tr\("pages\.mods\.installToNamed", \{ name: pluginServer\.meta\.name \}\)/s.test(mods) && /tr\("pages\.mods\.installToNamed", \{ name: currentInstance\.name \}\)/s.test(mods), "选中目标后按钮显示目标名（installToNamed）");
ok(/kind === "plugin"[\s\S]{0,220}pages\.mods\.serverInstall/.test(mods), "插件类型按钮文案 = 安装到服务端（pages.mods.serverInstall）");
ok(/pages\.mods\.installToInstance/.test(mods), "模组/其它类型按钮文案 = 安装到实例（pages.mods.installToInstance）");
ok(/setTargetModal\(\{ mod: selected, file: sortedFiles\[0\] \?\? null \}\)/.test(mods), "详情面板安装入口也开同一个弹窗");
ok(!/installDisabled=\{serverTarget/.test(mods), "详情面板按钮不再被 installDisabled 禁用死");
ok(!/AnchoredMenu/.test(mods) && !/data-menu-instance/.test(mods), "旧的行内实例下拉（AnchoredMenu）已从资源页移除");

// ---------- 5) 每页 10 条 ----------
say("");
say("=== 5) 每页条数 ===");
const pageSize = Number((mods.match(/const SEARCH_PAGE_SIZE = (\d+);/) || [])[1]);
say("    SEARCH_PAGE_SIZE = " + pageSize + "（ModsPage.tsx:" + lineOf(mods, "const SEARCH_PAGE_SIZE") + "）");
ok(pageSize === 10, "SEARCH_PAGE_SIZE 是 10");
ok(/fetchSearchPage\(\(target - 1\) \* SEARCH_PAGE_SIZE\)/.test(mods), "翻页 offset 仍按 SEARCH_PAGE_SIZE 算（页码逻辑不变）");
ok(/data-pager\b/.test(mods) && /data-pager-page-btn=/.test(mods) && /data-pager-prev/.test(mods) && /data-pager-next/.test(mods), "翻页控件 data-pager* 仍在");
ok(/results\.slice\(0, SEARCH_PAGE_SIZE\)/.test(mods) || /\.slice\(0, SEARCH_PAGE_SIZE\)/.test(mods), "当前页最多保留 SEARCH_PAGE_SIZE 张卡");

// ---------- 6) 网格：按视口宽度解析 CSS 级联，算 grid-template-columns ----------
say("");
say("=== 6) 结果网格（mods.css） ===");
const resolveGrid = (viewport, text) => {
  // 去注释后按 { } 逐块扫：记下每条规则的选择器与它所在的 @media 条件，最后按宽度取生效值。
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const stack = [];
  let buf = "";
  for (const ch of clean) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const head = stack.pop();
      if (head && head.includes(".res-grid") && !head.startsWith("@media")) {
        const media = stack.filter((h) => h.startsWith("@media")).pop() || "";
        const mm = media.match(/max-width:\s*(\d+)px/);
        rules.push({ max: mm ? Number(mm[1]) : null, body: buf });
      }
      buf = "";
      continue;
    }
    buf += ch;
  }
  let decl = null;
  for (const rule of rules) {
    if (rule.max !== null && viewport > rule.max) continue;
    const col = rule.body.match(/grid-template-columns:\s*([^;]+);/);
    if (col) decl = col[1].trim();
  }
  return { decl, order: rules.map((r) => (r.max === null ? "base" : "max-width:" + r.max)) };
};
const columnsOf = (decl) => {
  if (!decl) return null;
  const rep = decl.match(/repeat\((\d+)\s*,/);
  if (rep) return Number(rep[1]);
  const frs = decl.match(/\d*\.?\d*fr/g) || [];
  return frs.length || null;
};
const wide = resolveGrid(1440, css);
const narrow = resolveGrid(1000, css);
say("    .res-grid 规则顺序: " + wide.order.join(" → "));
say("    viewport 1440 → grid-template-columns: " + wide.decl + "  ⇒ " + columnsOf(wide.decl) + " 列（2 列 × 5 行）");
say("    viewport 1000 → grid-template-columns: " + narrow.decl + "  ⇒ " + columnsOf(narrow.decl) + " 列");
ok(columnsOf(wide.decl) === 2, "宽屏算出 2 列（不是 4 列）");
ok(columnsOf(narrow.decl) === 1, "窄屏退化成 1 列");
ok(!/auto-fill|auto-fit/.test(css.slice(css.indexOf(".res-grid"), css.indexOf(".res-grid") + 220)), "不再用 auto-fill（避免变成 4 列 × 2.5 行）");
ok(/\.target-modal\s*\{/.test(css) && /\.target-option\s*\{/.test(css) && /\.target-option:disabled\s*\{/.test(css), "弹窗与选项样式已加在 mods.css");

// ---------- 7) i18n 三语 ----------
say("");
say("=== 7) i18n 三语（i18n-extra.ts） ===");
const entryOf = (key, text) => {
  const i = text.indexOf('"' + key + '": D(');
  if (i < 0) return null;
  const j = text.indexOf("\n  ),", i);
  const k = text.indexOf("\n", i);
  const end = text.indexOf('D(', i) >= 0 && text[i + key.length + 4] === "\n" ? j + 5 : k;
  return text.slice(i, end > 0 ? end : k);
};
const newKeys = [
  "pages.mods.targetModalTitle",
  "pages.mods.installToInstance",
  "pages.mods.installToNamed",
  "pages.mods.targetModalNoInstances",
  "pages.mods.targetModalNoServers",
  "pages.mods.targetBusyInstance",
];
for (const key of newKeys) {
  const entry = entryOf(key, i18nExtra);
  const parts = entry ? (entry.match(/"((?:[^"\\]|\\.)*)"/g) || []).length : 0;
  ok(!!entry, "新增词条存在：" + key, entry ? entry.replace(/\s+/g, " ").slice(0, 120) : "缺失");
}
const triple = (key, text) => {
  const i = text.indexOf('"' + key + '": D(');
  if (i < 0) return null;
  const seg = text.slice(i + key.length + 6, i + key.length + 900);
  const m = seg.match(/^\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/);
  return m ? [m[1], m[2], m[3]] : null;
};
const sample = ["pages.mods.targetModalTitle", "pages.mods.targetInstances", "pages.mods.browseOnly"];
for (const key of sample) {
  const tr = triple(key, i18nExtra) || triple(key, i18nPages) || triple(key, i18nExtra + i18nPages);
  ok(!!tr && tr.every((s) => s.length > 0), "三语齐全：" + key, tr ? JSON.stringify(tr) : "缺失");
}
const groupKeys = ["pages.mods.targetInstances", "pages.mods.targetServers"];
for (const key of groupKeys) {
  const tr = triple(key, i18nExtra);
  ok(!!tr && tr.every(Boolean), "分组标题三语：" + key, tr ? JSON.stringify(tr) : "缺失");
}
const cancel = triple("pages.common.cancel", i18nPages);
ok(!!cancel && cancel.every(Boolean), "「取消」三语（复用 pages.common.cancel）", cancel ? JSON.stringify(cancel) : "缺失");

say("");
say(failed === 0 ? "ALL PASS (" + out.filter((l) => l.startsWith("PASS")).length + " 项)" : "FAILED: " + failed);
fs.writeFileSync(path.join(root, "scripts", ".res-target-modal-check.log"), out.join("\n") + "\n", "utf8");
console.log(out.join("\n"));
process.exit(failed === 0 ? 0 : 1);