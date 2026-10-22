// 冒烟：真实主进程 + preload + 渲染产物，遍历 9 个页面
const { app } = require("electron");
const pages = ["实例","账号","下载游戏","模组","Java","个性化","启动","其它","设置"];
const NAV_SEL = ".sidebar a, .sidebar button, aside a, aside button";
app.on("browser-window-created", (_e, win) => {
  const wc = win.webContents;
  wc.on("console-message", (_ev, level, message) => {
    if (level >= 2 && !/Security Warning/.test(String(message))) console.log("[renderer-error]", String(message).slice(0, 200));
  });
  wc.on("did-finish-load", async () => {
    if (!wc.getURL().startsWith("file:")) return;
    await new Promise((r) => setTimeout(r, 2500));
    const nav = await wc.executeJavaScript("[...document.querySelectorAll(\"" + NAV_SEL + "\")].map(n=>n.textContent.trim()).filter(Boolean)");
    console.log("[nav]", JSON.stringify(nav));
    for (const label of pages) {
      const ok = await wc.executeJavaScript("(async (t) => { const n=[...document.querySelectorAll(\"button,a\")].find(x=>x.textContent.trim()===t); if(!n) return false; n.click(); return true; })(" + JSON.stringify(label) + ")").catch(() => false);
      if (!ok) { console.log("[missing]", label); continue; }
      await new Promise((r) => setTimeout(r, 1300));
      const txt = await wc.executeJavaScript("document.body.innerText.replace(/\\s+/g,\" \").slice(0,180)").catch(() => "");
      console.log("[page:" + label + "]", txt);
    }
    const acc = await wc.executeJavaScript("(async () => { const a = await window.naiwa.accounts.list(); const s = await window.naiwa.settings.get(); return { accounts: a.length, activeId: s.activeAccountId, isolation: s.versionIsolation, theme: s.theme, titleBar: s.titleBar, key: s.curseforgeApiKey ? \"set\" : \"empty\" }; })().catch(e => ({ error: String(e).slice(0,150) }))").catch((e) => ({ error: String(e).slice(0, 150) }));
    console.log("[ipc]", JSON.stringify(acc));
    console.log("[done]");
    app.quit();
  });
});
require("../dist-electron/main/main.js");
setTimeout(() => { console.log("[hard-timeout]"); app.quit(); }, 120000);
