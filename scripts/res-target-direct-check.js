// 0.4.2(D) 资源页：已选目标就直接安装（不再弹窗）自检。
// 用法：node scripts/res-target-direct-check.js  （结果同时写入 scripts/.res-target-direct-check.log）
// 说明：本仓库没有浏览器 / jsdom 运行环境，所以除了源码断言，还把 ModsPage.tsx 里
//       installFromCard / runServerInstall / installTarget / installTargetTitle 的**真实源码片段**
//       抽出来用 new Function 配上桩（setTargetModal / installContent / plugins / api）真跑一遍：
//       断言的是执行结果，不是字符串匹配。
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
const mods = read("src/renderer/pages/ModsPage.tsx");
const i18nExtra = read("src/renderer/lib/i18n-extra.ts");

// ---------- 抽取工具：按大括号 / 圆括号配对切出真实语句 ----------
const braceBlock = (text, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
  }
  return null;
};
const statementAfter = (text, marker) => {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === ";" && depth === 0) return text.slice(from, i);
  }
  return null;
};
const bodyAfter = (text, marker) => {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const open = text.indexOf("{", start + marker.length);
  return open < 0 ? null : braceBlock(text, open);
};

// ---------- tr 桩：直接用 i18n-extra.ts 里真实的中文词条 ----------
const triple = (key, text) => {
  const i = text.indexOf('"' + key + '": D(');
  if (i < 0) return null;
  const m = text.slice(i + key.length + 6, i + key.length + 900)
    .match(/^\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/);
  return m ? { zh: m[1], en: m[2], jp: m[3] } : null;
};
const zh = {};
for (const key of ["pages.mods.installToNamed", "pages.mods.installToInstance", "pages.mods.serverInstall",
  "pages.mods.chooseInstallTarget", "pages.mods.targetModalTitle", "pages.mods.installing"]) {
  const tr3 = triple(key, i18nExtra);
  zh[key] = tr3 ? tr3.zh : null;
}
const tr = (key, vars) => {
  const text = zh[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text;
};

// ---------- 1) 目标判定（installTarget 表达式真跑） ----------
say("=== 1) installTarget 判定（ModsPage.tsx:" + lineOf(mods, "const installTarget:") + "，表达式真跑） ===");
const targetStmt = statementAfter(mods, "const installTarget:");
ok(!!targetStmt, "installTarget 声明已找到");
const targetExpr = targetStmt.slice(targetStmt.indexOf("=") + 1).trim();
const evalTarget = (env) => new Function("serverKindOk", "serverTarget", "pluginServer", "kind", "currentInstance",
  "return (" + targetExpr + ");")(env.serverKindOk, env.serverTarget, env.pluginServer, env.kind, env.currentInstance);
const inst26 = { id: "inst-26-1-forge", name: "26.1 Forge", mcVersion: "1.21.1", loader: "forge" };
const instOther = { id: "inst-fabric-opt", name: "Fabulously Optimized", mcVersion: "1.21.1", loader: "fabric" };
const srvPaper = { meta: { id: "srv-paper-1", name: "Paper 1.21", mcVersion: "1.21.1", core: "paper" } };
const cases = [
  ["mod", true, false, null, inst26],
  ["mod", true, false, null, instOther],
  ["plugin", true, true, srvPaper, null],
  ["plugin", true, false, null, inst26],
  ["shader", false, true, srvPaper, inst26],
  ["mod", false, false, null, null],
];
for (const [kind, serverKindOk, serverTarget, pluginServer, currentInstance] of cases) {
  const got = evalTarget({ serverKindOk, serverTarget, pluginServer, kind, currentInstance });
  say("    kind=" + kind.padEnd(12) + " serverKindOk=" + String(serverKindOk).padEnd(5)
    + " serverTarget=" + String(serverTarget).padEnd(5) + " → " + (got ? got.kind + ":" + got.name : "null"));
}
ok(JSON.stringify(evalTarget({ serverKindOk: true, serverTarget: false, pluginServer: null, kind: "mod", currentInstance: inst26 }))
  === JSON.stringify({ kind: "instance", name: "26.1 Forge" }), "模组 + 当前实例 → 目标是该实例");
ok(evalTarget({ serverKindOk: true, serverTarget: false, pluginServer: null, kind: "mod", currentInstance: instOther }).name
  === "Fabulously Optimized", "换实例后目标名立刻跟着变（data-target-name / 文案同源）");
ok(JSON.stringify(evalTarget({ serverKindOk: true, serverTarget: true, pluginServer: srvPaper, kind: "plugin", currentInstance: null }))
  === JSON.stringify({ kind: "server", name: "Paper 1.21" }), "插件 + 已选服务端 → 目标是该服务端");
ok(evalTarget({ serverKindOk: true, serverTarget: false, pluginServer: null, kind: "plugin", currentInstance: inst26 }) === null,
  "插件没选服务端（哪怕有当前实例）→ 视为没目标，仍走弹窗");
ok(evalTarget({ serverKindOk: false, serverTarget: true, pluginServer: srvPaper, kind: "shader", currentInstance: inst26 }) === null,
  "光影/资源包（服务端不可用）残留服务端选择 → 按没目标处理，仍走弹窗");
ok(evalTarget({ serverKindOk: true, serverTarget: false, pluginServer: null, kind: "mod", currentInstance: null }) === null,
  "既没实例也没服务端 → 没目标");

// ---------- 2) 卡片点击（installFromCard 真实函数体 + 桩） ----------
say("");
say("=== 2) 卡片按钮点击（ModsPage.tsx:" + lineOf(mods, "const installFromCard = async")
  + "，真实函数体 + 桩执行） ===");
const cardBody = bodyAfter(mods, "const installFromCard = async (mod: ModSearchResult) =>");
ok(!!cardBody, "installFromCard 函数体已抽到");
const makeCard = (env) => new Function("installTarget", "currentInstance", "setTargetModal", "installToServer", "installContent",
  "return async function installFromCard(mod) {" + cardBody + "};")(
  env.installTarget, env.currentInstance, env.setTargetModal, env.installToServer, env.installContent);
const stubEnv = (target) => {
  const calls = { modal: [], server: [], content: [] };
  return {
    calls,
    installTarget: target,
    currentInstance: inst26,
    setTargetModal: (v) => calls.modal.push(v),
    installToServer: async (mod, file) => calls.server.push({ projectId: mod.projectId, provider: mod.provider, file }),
    installContent: async (mod, instance, file) => calls.content.push({
      projectId: mod.projectId, provider: mod.provider, instanceId: instance.id, instanceName: instance.name, file,
    }),
  };
};
const modStub = { provider: "curseforge", projectId: "238222", slug: "jei", title: "Just Enough Items" };

async function main() {
// ① 有目标（实例）
const withInstance = stubEnv({ kind: "instance", name: "26.1 Forge" });
say("    场景A 有实例目标：点击卡片按钮");
say("    源码分支 ModsPage.tsx:" + lineOf(mods, 'if (installTarget.kind === "server")')
  + " → " + lineOf(mods, "if (currentInstance) await installContent(mod, currentInstance, null);"));
await makeCard(withInstance)(modStub);
ok(withInstance.calls.modal.length === 0,
  "① 有目标时点击**不**打开弹窗（setTargetModal 调用 0 次 ⇒ targetModal 保持 null ⇒ 「" + lineOf(mods, "{targetModal ? (")
  + " 行 {targetModal ? (」分支不渲染 [data-target-modal]）", "modal calls=" + withInstance.calls.modal.length);
ok(withInstance.calls.server.length === 0 && withInstance.calls.content.length === 1,
  "③ 有实例目标时点击走 installContent（安装队列接口）", JSON.stringify(withInstance.calls.content));
ok(withInstance.calls.content[0].instanceId === "inst-26-1-forge"
  && withInstance.calls.content[0].projectId === "238222" && withInstance.calls.content[0].provider === "curseforge",
  "③ 桩记录的 installContent 参数", "projectId=" + withInstance.calls.content[0].projectId
  + " targetInstanceId=" + withInstance.calls.content[0].instanceId + " file=" + JSON.stringify(withInstance.calls.content[0].file));

// ② 无目标
const withoutTarget = stubEnv(null);
say("    场景B 没有目标：点击卡片按钮");
await makeCard(withoutTarget)(modStub);
ok(withoutTarget.calls.modal.length === 1 && withoutTarget.calls.modal[0].mod === modStub
  && withoutTarget.calls.modal[0].file === null,
  "② 没目标时点击仍打开「安装到…」弹窗（setTargetModal({mod, file:null})）", JSON.stringify(withoutTarget.calls.modal.length));
ok(withoutTarget.calls.content.length === 0 && withoutTarget.calls.server.length === 0,
  "没目标时点击不发任何安装请求", "content=" + withoutTarget.calls.content.length + " server=" + withoutTarget.calls.server.length);

// ③ 有目标（服务端）：installFromCard → installToServer → runServerInstall 真跑
const withServer = stubEnv({ kind: "server", name: "Paper 1.21" });
const srvCalls = { install: [], content: [] };
const serverBody = bodyAfter(mods, "const runServerInstall = async (");
ok(!!serverBody, "runServerInstall 函数体已抽到（ModsPage.tsx:" + lineOf(mods, "const runServerInstall = async (") + "）");
const runServerInstall = new Function("kind", "serverContentKindOf", "push", "tr", "setPluginBusyKey", "setPluginRefresh",
  "keyOf", "plugins", "api",
  "return async function runServerInstall(mod, targetServerId, targetName, file) {"
  + serverBody.replace(/catch \(error: unknown\)/, "catch (error)") + "};")(
  "plugin",
  (k) => (k === "plugin" ? "plugin" : k === "mod" ? "mod" : null),
  () => undefined,
  tr,
  () => undefined,
  () => undefined,
  (mod) => mod.provider + ":" + mod.projectId,
  { install: async (req) => { srvCalls.install.push(req); } },
  { servers: { contentInstall: async (req) => { srvCalls.content.push(req); } } },
);
withServer.installToServer = async (mod, file) => runServerInstall(mod, "srv-paper-1", "Paper 1.21", file);
say("    场景C 有服务端目标：点击卡片按钮（installToServer → runServerInstall 真跑）");
await makeCard(withServer)(modStub);
ok(withServer.calls.modal.length === 0, "① 有服务端目标时点击同样不打开弹窗");
ok(srvCalls.install.length === 1 && srvCalls.content.length === 0,
  "③ 插件服务端目标 → 真的调用 plugins.install", JSON.stringify(srvCalls.install));
ok(srvCalls.install[0].serverId === "srv-paper-1" && srvCalls.install[0].projectId === "238222"
  && srvCalls.install[0].provider === "curseforge" && srvCalls.install[0].fileId === undefined,
  "③ 桩记录的 services 安装接口参数", "serverId(targetId)=" + srvCalls.install[0].serverId
  + " projectId=" + srvCalls.install[0].projectId + " fileId=" + String(srvCalls.install[0].fileId));


}

main().then(() => {
// ---------- 3) 按钮 title / 文案两态（表达式真跑） ----------
say("");
say("=== 3) 按钮 title 与文案（title:" + lineOf(mods, "const installTargetTitle =")
  + " 文案:" + lineOf(mods, "const installTargetLabel =") + "，表达式真跑） ===");
const titleExpr = statementAfter(mods, "const installTargetTitle =").replace(/^\s*=?\s*/, "");
const evalTitle = (installTarget, serverBlockHint) => new Function("tr", "serverBlockHint", "installTarget",
  "return (" + titleExpr.replace(/^\s*=\s*/, "") + ");")(tr, serverBlockHint, installTarget);
const labelStmt = statementAfter(mods, "const installTargetLabel =");
const labelExpr = labelStmt.replace(/^\s*=\s*/, "");
const evalLabel = (kind, pluginServer, currentInstance) => new Function("tr", "kind", "pluginServer", "currentInstance",
  "return (" + labelExpr + ");")(tr, kind, pluginServer, currentInstance);
const titleWith = evalTitle({ kind: "instance", name: "26.1 Forge" }, null);
const titleWithout = evalTitle(null, null);
const titleBlocked = evalTitle(null, "该服务端只能装插件");
say("    有目标 → title = " + JSON.stringify(titleWith));
say("    没目标 → title = " + JSON.stringify(titleWithout));
ok(titleWith === "安装到「26.1 Forge」", "④ 有目标时 title 说明会装到哪", titleWith);
ok(titleWithout === zh["pages.mods.chooseInstallTarget"] && titleWithout === "选择安装目标",
  "④ 没目标时 title = 「选择安装目标」（新增词条 pages.mods.chooseInstallTarget）", titleWithout);
ok(titleBlocked === "该服务端只能装插件", "④ 被能力门禁拦住时 title 先给原因", titleBlocked);
const labelWith = evalLabel("mod", null, inst26);
const labelNoTarget = evalLabel("mod", null, null);
const labelPluginNoServer = evalLabel("plugin", null, inst26);
say("    有目标 → 文案 = " + JSON.stringify(labelWith));
say("    没目标（模组）→ 文案 = " + JSON.stringify(labelNoTarget));
say("    没目标（插件）→ 文案 = " + JSON.stringify(labelPluginNoServer));
ok(labelWith === "安装到「26.1 Forge」", "④ 有目标时按钮文案带目标名", labelWith);
ok(labelNoTarget === "安装到实例", "④ 没目标时模组文案 = 安装到实例", labelNoTarget);
ok(labelPluginNoServer === "安装到服务端", "④ 没目标时插件文案 = 安装到服务端", labelPluginNoServer);
ok(zh["pages.mods.chooseInstallTarget"] === "选择安装目标", "新增词条三语齐全（zh/en/jp）",
  JSON.stringify(triple("pages.mods.chooseInstallTarget", i18nExtra)));

// ---------- 4) DOM 契约与副作用 ----------
say("");
say("=== 4) DOM 契约 / 副作用 ===");
const cardStart = mods.indexOf("data-install-target={key}");
const cardBtn = mods.slice(cardStart, mods.indexOf("</button>", cardStart));
ok(/data-target-name=\{installTarget\?\.name\}/.test(cardBtn), "data-target-name 直接取 installTarget.name（目标一变就变）");
ok(/data-install-direct=\{installTarget \? "1" : "0"\}/.test(cardBtn), "data-install-direct 标出这一下是直装还是开弹窗");
ok(/onClick=\{\(\) => void installFromCard\(mod\)\}/.test(cardBtn), "卡片按钮点击 = installFromCard（不是无条件开弹窗）");
ok(/title=\{installTargetTitle\}/.test(cardBtn), "按钮 title 走 installTargetTitle");
ok(/disabled=\{pluginBusyKey === key\}/.test(cardBtn), "安装中禁用逻辑不变（只看 pluginBusyKey）");
ok(/aria-haspopup=\{installTarget === null \? "dialog" : undefined\}/.test(cardBtn), "只有没目标时按钮才声明 aria-haspopup=dialog");
ok(/\{installTarget === null \? <IconChevronDown size=\{14\} \/> : null\}/.test(cardBtn), "有目标时不再画「下拉」箭头（点了就是装）");
const modalIndex = mods.indexOf("{targetModal ? (");
ok(modalIndex > 0 && /data-target-modal data-target-modal-kind/.test(mods.slice(modalIndex)),
  "弹窗仍在：{targetModal ? ( → [data-target-modal]（ModsPage.tsx:" + lineOf(mods, "data-target-modal data-target-modal-kind") + "）");
ok(/onInstall=\{\(\) => \{[\s\S]{0,400}?setTargetModal\(\{ mod: selected, file: sortedFiles\[0\] \?\? null \}\)/.test(mods),
  "详情面板按钮仍开弹窗（保留换目标入口，ModsPage.tsx:" + lineOf(mods, "setTargetModal({ mod: selected, file: sortedFiles[0] ?? null })") + "）");
ok(/const pickTargetInstance = async \(mod: ModSearchResult, instance: InstanceMeta, file: ModFileInfo \| null\) => \{\s*setTargetModal\(null\);\s*setServerId\(""\);\s*setCurrentInstanceId\(instance\.id\);/.test(mods),
  "弹窗选实例写回共享状态（setCurrentInstanceId / setServerId）");
ok(/const pickTargetServer = async[\s\S]{0,600}?setServerId\(entry\.meta\.id\)/.test(mods),
  "弹窗选服务端写回共享状态（setServerId）");
ok(/data-target-select/.test(mods), "侧栏「安装目标」下拉仍在（data-target-select 换目标入口）");

say("");
say(failed === 0 ? "ALL PASS (" + out.filter((l) => l.startsWith("PASS")).length + " 项)" : "FAILED: " + failed);
fs.writeFileSync(path.join(root, "scripts", ".res-target-direct-check.log"), out.join("\n") + "\n", "utf8");
console.log(out.join("\n"));
process.exit(failed === 0 ? 0 : 1);
});
