// 0.4.1 资源页「插件」类型 + 来源二级类型调整：源码级自检（无浏览器环境，断言落在源码与构建产物上）
// 用法：node scripts/res-plugin-check.js  （结果同时写入 scripts/.res-plugin-check.log）
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
const lineOf = (text, needle) => {
  const i = text.indexOf(needle);
  return i < 0 ? -1 : text.slice(0, i).split("\n").length;
};
const count = (text, needle) => text.split(needle).length - 1;

const mods = read("src/renderer/pages/ModsPage.tsx");
const modKind = read("src/renderer/lib/modKind.ts");
const i18nPages = read("src/renderer/lib/i18n-pages.ts");
const i18nExtra = read("src/renderer/lib/i18n-extra.ts");
const detailPanel = read("src/renderer/components/ModDetailPanel.tsx");

say("=== 0) tsc/vite 由外层命令给出；这里是源码断言 ===");

// ---------- 1) SOURCE_TABS 最终形态 ----------
const srcBlock = mods.match(/const SOURCE_TABS[\s\S]*?\n\];/)[0];
say("--- SOURCE_TABS（ModsPage.tsx:" + lineOf(mods, "const SOURCE_TABS") + "）---");
srcBlock.split("\n").forEach((l) => say("    " + l.trim()));
const tabsOf = (name) => {
  const m = srcBlock.match(new RegExp('value: "' + name + '"[^\\]]*kinds: \\[([^\\]]*)\\]'));
  return m ? m[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean) : null;
};
const mr = tabsOf("modrinth"), mk = tabsOf("minekuai"), cf = tabsOf("curseforge");
ok(!!mr && !!mk && !!cf, "三个来源的 kinds 都能解析", JSON.stringify({ mr, mk, cf }));
ok(mr.indexOf("datapack") < 0, "Modrinth 不再列 datapack", JSON.stringify(mr));
ok(mk.indexOf("map") < 0, "麦块社区不再列 map", JSON.stringify(mk));
ok(mr[mr.length - 1] === "plugin" && mk[mk.length - 1] === "plugin", "plugin 排在 modrinth/minekuai 的 kinds 末位（光影之后）", JSON.stringify({ mr, mk }));
ok(cf.indexOf("plugin") < 0, "plugin 不在 curseforge 的「支持」清单里（它靠 DISABLED_KINDS 置灰出现）", JSON.stringify(cf));

// ---------- 2) KIND_TABS 与置灰机制 ----------
const kindTabsBlock = modKind.match(/export const KIND_TABS[\s\S]*?\n\];/)[0];
const kindOrder = [...kindTabsBlock.matchAll(/value: "(\w+)"/g)].map((m) => m[1]);
say("--- KIND_TABS 顺序（modKind.ts:" + lineOf(modKind, "export const KIND_TABS") + "）: " + kindOrder.join(" → "));
ok(kindOrder.indexOf("plugin") === kindOrder.indexOf("shader") + 1, "KIND_TABS 里 plugin 紧跟 shader");
ok(kindOrder.indexOf("datapack") < 0 && kindOrder.indexOf("map") < 0, "KIND_TABS 里已经没有 datapack / map 标签", JSON.stringify(kindOrder));

const disabledBlock = mods.match(/const DISABLED_KINDS[^;]*;/)[0];
say("--- 置灰清单（ModsPage.tsx:" + lineOf(mods, "const DISABLED_KINDS") + "）: " + disabledBlock.replace(/\s+/g, " "));
const disabledOf = (() => {
  const m = disabledBlock.match(/curseforge: \[([^\]]*)\]/);
  return m ? m[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean) : [];
})();
const shownFor = (src) => kindOrder.filter((k) => (src === "modrinth" ? mr : src === "minekuai" ? mk : cf).concat(src === "curseforge" ? disabledOf : []).includes(k));
for (const s of ["modrinth", "minekuai", "curseforge"]) {
  const list = shownFor(s);
  say("--- 来源 " + s + " 的类型栏: " + list.map((k) => k + (disabledOf.includes(k) && s === "curseforge" ? "(置灰)" : "")).join(" / "));
}
ok(shownFor("curseforge").includes("plugin") && disabledOf.includes("plugin"), "CurseForge 下 plugin 标签仍出现但置灰");
ok(!shownFor("modrinth").includes("datapack") && !shownFor("minekuai").includes("map"), "数据包 / 地图标签在任何来源下都不再出现");

const kindTabJsx = mods.slice(mods.indexOf("{kindTabs.map((tab) => {"), mods.indexOf("{kindTabs.map((tab) => {") + 900);
say("--- 类型标签 JSX（ModsPage.tsx:" + lineOf(mods, "{kindTabs.map((tab) => {") + "）---");
kindTabJsx.split("\n").slice(0, 24).forEach((l) => say("    " + l.trim()));
ok(kindTabJsx.includes("data-kind-option={tab.value}"), "标签带 data-kind-option（plugin 也就带上）");
ok(kindTabJsx.includes("data-kind-disabled={disabled ? \"1\" : undefined}"), "置灰走 data-kind-disabled");
ok(kindTabJsx.includes("disabled={disabled}"), "置灰标签 disabled（点不动）");
ok(kindTabJsx.includes("title={disabled && titleKey ? tr(titleKey) : undefined}"), "置灰标签 title 说明原因");
ok(mods.includes('const KIND_DISABLED_TITLE_KEY: Partial<Record<UiContentKind, string>> = { plugin: "pages.mods.pluginCurseforgeHint" };'), "置灰 title 指向 pages.mods.pluginCurseforgeHint");

// ---------- 3) 插件：目标服务端选择器 ----------
const asideIdx = mods.indexOf("data-target-select");
say("--- 目标服务端选择器（ModsPage.tsx:" + lineOf(mods, "data-plugin-server-select") + "）---");
mods.slice(asideIdx, asideIdx + 1200).split("\n").slice(0, 22).forEach((l) => say("    " + l.trim()));
ok(asideIdx > 0, "侧栏的目标选择器同时列出实例与服务端");
ok(mods.includes('data-plugin-server-select'), "服务端选择器带 data-plugin-server-select");
ok(mods.includes("data-plugin-need-server"), "未选服务端时提示节点存在");
ok(mods.includes("api.servers.list()"), "服务端列表读 api.servers.list()");
ok(mods.includes("api.plugins"), "插件接口读 api.plugins（契约已落地）");
ok(mods.includes("plugins.installed(serverId)"), "已装判定用 api.plugins.installed(serverId)");

// ---------- 4) 卡片按钮：插件 vs 模组 ----------
const cardBtn = mods.indexOf("data-plugin-install={key}");
say("--- 卡片安装按钮（ModsPage.tsx:" + lineOf(mods, "data-plugin-install={key}") + "）---");
mods.slice(cardBtn - 400, cardBtn + 500).split("\n").forEach((l) => say("    " + l.trim()));
ok(cardBtn > 0, "卡片有插件安装按钮 data-plugin-install");
const pluginBtnBlock = mods.slice(cardBtn - 300, cardBtn + 900);
ok(pluginBtnBlock.includes("disabled={!pluginServer || serverBlocked || pluginBusyKey === key}"), "未选服务端 / 核心不支持时安装按钮 disabled");
ok(pluginBtnBlock.includes('data-plugin-need-server') || mods.includes('data-plugin-need-server'), "卡片上有「先选一个服务端」提示节点");
ok(pluginBtnBlock.includes('tr("pages.mods.serverInstall")'), "服务端安装按钮文案走 pages.mods.serverInstall");

const zhOf = (file, key) => {
  // 词典里有些文案含转义引号：先统一替换掉，正则才好写。
  const clean = file.replaceAll(String.fromCharCode(92) + '"', "'");
  const m = clean.match(new RegExp('"' + key.replace(/\./g, "\\.") + '": D\\(\\s*"([^"]*)"\\s*,\\s*"([^"]*)"\\s*,\\s*"([^"]*)"\\s*,?\\s*\\)'));
  return m ? { zh: m[1], en: m[2], ja: m[3] } : null;
};
const label = (key) => zhOf(i18nExtra, key) || zhOf(i18nPages, key);
const installKeys = modKind.match(/export const KIND_INSTALL_LABEL_KEY[\s\S]*?\n\};/)[0];
const keyOfKind = (kind) => {
  const m = installKeys.match(new RegExp("  " + kind + ': "([^"]+)"'));
  return m ? m[1] : null;
};
const pluginLabel = label(keyOfKind("plugin"));
const modLabel = label(keyOfKind("mod"));
say("--- KIND_INSTALL_LABEL_KEY: plugin → " + keyOfKind("plugin") + " / mod → " + keyOfKind("mod"));
say("    plugin 文案: " + JSON.stringify(pluginLabel));
say("    mod    文案: " + JSON.stringify(modLabel));
ok(pluginLabel && pluginLabel.zh === "安装到服务端", "plugin 文案中文是「安装到服务端」");
ok(pluginLabel && modLabel && pluginLabel.zh !== modLabel.zh, "plugin 与 mod 的按钮文案不同");
ok(mods.includes('installLabel={selectedGrade ? tr("pages.mods.reinstall") : tr(KIND_INSTALL_LABEL_KEY[detailKind])}'), "详情面板按钮文案按 detailKind 取（plugin → 安装到服务端）");
ok(detailPanel.includes("installDisabled?: boolean;") && detailPanel.includes("disabled={installing || !data || installDisabled || sideUnsupported}"), "详情面板支持 installDisabled（未选服务端 / 核心不支持 / 仅客户端时禁用）");

// ---------- 5) 翻页控件仍在 ----------
say("--- 翻页护栏（ModsPage.tsx:" + lineOf(mods, "  {!noKey && (results.length > 0 || page > 1) ? (") + "）---");
const pagerGuard = mods.match(/\{[^\n]*results\.length > 0 \|\| page > 1[^\n]*/g) || [];
pagerGuard.forEach((l) => say("    " + l.trim()));
ok(pagerGuard.length >= 1, "结果列表的翻页条护栏存在");
ok(!/isMap|isDatapack|isPlugin/.test(pagerGuard.join("")), "翻页条护栏不含任何 kind 条件（插件类型同样生效）");
ok(mods.includes("data-pager-page={props.page}") && mods.includes("data-pager-prev") && mods.includes("data-pager-next"), "Pager 的三个 data-pager* 属性都在");
ok(count(mods, "<Pager") === 1, "页面里只剩一个 Pager（地图那套已删）", "count=" + count(mods, "<Pager"));

// ---------- 6) 地图 / 数据包死代码清理 ----------
for (const [needle, label2] of [["isMap", "isMap"], ["isDatapack", "isDatapack"], ["api.mods.maps", "api.mods.maps 调用"], ["MapCards", "MapCards 组件"], ["MapEntry", "MapEntry 类型"], ["downloadMap", "downloadMap"], ["mapsPage", "地图分页状态"], ["loadMoreMaps", "loadMoreMaps"]]) {
  ok(count(mods, needle) === 0, "ModsPage 里已经没有 " + label2, "count=" + count(mods, needle));
}
ok(modKind.indexOf("KIND_EMPTY_HINT_KEY") < 0, "modKind 里删掉了没人用的 KIND_EMPTY_HINT_KEY");
const mainMaps = read("src/main/mods/index.ts");
ok(mainMaps.includes("listMapEntries"), "主进程 listMapEntries 保留（不在本单边界内）");

// ---------- 7) 三语抽查 ----------
say("--- 三语抽查（i18n-extra.ts）---");
for (const key of ["pages.mods.kindPlugin", "pages.mods.pluginInstall", "pages.mods.badgePlugin", "pages.mods.pluginPickServerFirst", "pages.modDetail.pluginInstallTo"]) {
  const v = zhOf(i18nExtra, key);
  ok(!!v, key + " 三语齐全", v ? JSON.stringify(v) : "missing");
}
const pluginKeys = [...i18nExtra.matchAll(/"pages\.(mods\.plugin|mods\.kindPlugin|mods\.badgePlugin|modDetail\.plugin)[A-Za-z]*"/g)].map((m) => m[0]);
ok(pluginKeys.length >= 16, "i18n-extra 追加的插件键数量", pluginKeys.length + " keys: " + pluginKeys.join(", "));

// ---------- 7.5) 核心 → 插件平台（直接跑 modKind.ts 的真实逻辑） ----------
const ts = require("typescript");
const modKindJs = ts.transpileModule(modKind, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modKindModule = { exports: {} };
new Function("module", "exports", "require", modKindJs)(modKindModule, modKindModule.exports, () => ({ loaderLabel: () => "" }));
const mkApi = modKindModule.exports;
say("--- 核心 → 插件平台（modKind.ts CORE_PLUGIN_PLATFORMS）---");
for (const [core, list] of Object.entries(mkApi.CORE_PLUGIN_PLATFORMS)) {
  say("    " + core.padEnd(10) + " → " + (list.length > 0 ? list.join(", ") : "(模组服：不加载插件)"));
}
const caseVelocity = mkApi.checkPluginPlatform(["velocity"], "Paper");
const casePaper = mkApi.checkPluginPlatform(["paper", "spigot"], "Paper");
say("    用例1 Paper 服务端 + velocity 文件 → " + JSON.stringify(caseVelocity));
say("    用例2 Paper 服务端 + paper 文件    → " + JSON.stringify(casePaper));
ok(caseVelocity.mismatch === true, "用例1：Paper + velocity 文件 → 需要 data-plugin-platform-warn");
ok(casePaper.mismatch === false, "用例2：Paper + paper 文件 → 不提示");
ok(mkApi.isModdedServerCore("Fabric") && mkApi.isModdedServerCore("Forge") && mkApi.isModdedServerCore("NeoForge") && !mkApi.isModdedServerCore("Paper"), "模组服判定：Fabric/Forge/NeoForge 是，Paper 不是");
ok(mkApi.checkPluginPlatform(["paper"], "Fabric").mismatch === false, "模组服不报平台不匹配（走整体「模组服」提示）", JSON.stringify(mkApi.checkPluginPlatform(["paper"], "Fabric")));
ok(mkApi.checkPluginPlatform([], "Paper").mismatch === false, "文件没写平台 → 不提示", JSON.stringify(mkApi.checkPluginPlatform([], "Paper")));

say("--- 平台提示的接线（ModsPage / ModDetailPanel）---");
ok(mods.includes('data-plugin-platform-warn={platform?.filePlatforms.join("/")}'), "文件行有 data-plugin-platform-warn 提示节点");
ok(mods.includes("const platform = serverTarget && pluginServer"), "平台比对用目标服务端的 core");
ok(detailPanel.includes("installTitle?: string;") && detailPanel.includes("title={sideUnsupported"), "详情面板安装按钮 title 会写清楚原因");
ok(detailPanel.includes("installDisabled?: boolean;"), "详情面板支持 installDisabled");

say("--- 统一目标选择器（实例 + 服务端同列）---");
ok(mods.includes('data-target-kind={targetKind}') && mods.includes("data-target-id={serverTarget ? serverId"), "选择器带 data-target-kind / data-target-id");
ok(mods.includes('data-target-kind="instance"') && mods.includes('data-target-kind="server"'), "每个选项也带 data-target-kind（实例/服务端两组）");
ok(mods.includes("<optgroup label={tr(\"pages.mods.targetInstances\")}") && mods.includes('<optgroup label={tr("pages.mods.targetServers")} disabled={!serverKindOk}>'), "实例组 + 服务端组（不支持的类型服务端组置灰）");
ok(mods.includes("api.servers.capabilities(serverId)"), "能力表读 api.servers.capabilities(serverId)");
ok(mods.includes("api.servers.contentInstalled(serverId, \"mod\")"), "选服务端时已装判定读 api.servers.contentInstalled");
ok(mods.includes("api.servers.contentInstall({"), "模组装服务端走 api.servers.contentInstall");
ok(mods.includes("disabled={!pluginServer || serverBlocked || pluginBusyKey === key}"), "卡片安装按钮按能力门禁置灰");
ok(mods.includes('data-server-blocked={serverBlocked ? "1" : undefined}'), "卡片按钮暴露 data-server-blocked 供自检");
ok(detailPanel.includes('targetKind?: "instance" | "server";') && mods.includes("targetKind={targetKind}"), "详情面板知道目标类型");

say("--- 三种组合（真跑 modKind.ts 的门禁逻辑）---");
const gModFabric = mkApi.serverTargetGate("mod", "Fabric");
const gModPaper = mkApi.serverTargetGate("mod", "Paper");
const gPluginFabric = mkApi.serverTargetGate("plugin", "Fabric");
const gPluginPaper = mkApi.serverTargetGate("plugin", "Paper");
const gShaderPaper = mkApi.serverTargetGate("shader", "Paper");
const gModVanilla = mkApi.serverTargetGate("mod", "Vanilla");
say("    模组 → Fabric 服 : " + JSON.stringify(gModFabric));
say("    模组 → Paper 服  : " + JSON.stringify(gModPaper));
say("    插件 → Fabric 服 : " + JSON.stringify(gPluginFabric));
say("    插件 → Paper 服  : " + JSON.stringify(gPluginPaper));
say("    模组 → Vanilla 服: " + JSON.stringify(gModVanilla));
say("    光影 → Paper 服  : " + JSON.stringify(gShaderPaper));
ok(gModFabric.allowed === true, "模组 + modded 服 → 允许安装");
ok(gModPaper.allowed === false && gModPaper.reasonKey === "pages.mods.modOnPluginServer", "模组 + 插件服 → 置灰并提示「这是插件服」");
ok(gModVanilla.allowed === false && gModVanilla.reasonKey === "pages.mods.modOnVanillaServer", "模组 + 原版服 → 置灰并提示「原版不支持模组」");
ok(gPluginFabric.allowed === false && gPluginFabric.reasonKey === "pages.mods.pluginOnModdedServer", "插件 + modded 服 → 置灰并提示「这是模组服」");
ok(gPluginPaper.allowed === true, "插件 + 插件服 → 允许安装");
ok(gShaderPaper.allowed === false && gShaderPaper.reasonKey === "pages.mods.serverTargetUnsupported", "光影/资源包/整合包 → 服务端目标不可用");
ok(mods.includes("data-server-blocked-hint") && mods.includes("{serverBlockHint}"), "卡片把门禁原因显示出来");
ok(mods.includes('data-plugin-modded-server'), "门禁原因节点仍带 data-plugin-modded-server（兼容旧断言）");

say("--- 服务端支持度（ModDetail.serverSide）---");
ok(detailPanel.includes("serverSide === \"unsupported\""), "详情面板读 ModDetail.serverSide");
ok(detailPanel.includes('data-mod-server-unsupported'), "unsupported → data-mod-server-unsupported 提示");
ok(detailPanel.includes("disabled={installing || !data || installDisabled || sideUnsupported}"), "unsupported → 安装按钮置灰");
ok(detailPanel.includes('data-mod-server-unknown'), "unknown/缺失 → 只提示不禁用");
ok(detailPanel.includes('data-mod-server-required'), "required → 提示「必需在服务端安装」");

// ---------- 8) 构建产物里确实带上了这些锚点 ----------
const assets = fs.readdirSync(path.join(root, "dist/renderer/assets"));
const bundle = assets.filter((f) => f.startsWith("index-") && f.endsWith(".js"))[0];
const js = read("dist/renderer/assets/" + bundle);
for (const mark of ["data-plugin-server-select", "data-plugin-install", "data-kind-option", "data-pager", "pluginCurseforgeHint"]) {
  ok(js.includes(mark), "构建产物 " + bundle + " 含 " + mark);
}

say("");
say(failed === 0 ? "ALL PASS" : "FAILED " + failed);
fs.writeFileSync(path.join(__dirname, ".res-plugin-check.log"), out.join("\n") + "\n", "utf8");
console.log((failed === 0 ? "ALL PASS" : "FAILED " + failed) + " (details in scripts/.res-plugin-check.log)");
process.exit(failed === 0 ? 0 : 1);
