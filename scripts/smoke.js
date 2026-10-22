// 冒烟测试 3：等待 boot 完成（最长 40s），再逐页导航，抓渲染端错误。
const { app } = require("electron");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on("browser-window-created", (_e, win) => {
  const wc = win.webContents;
  wc.on("console-message", (_ev, level, message) => {
    if (level >= 2 && !/Security Warning/.test(message)) console.log("[renderer-error]", String(message).slice(0, 240));
  });
  wc.on("did-finish-load", async () => {
    if (!wc.getURL().startsWith("file:")) return;
    const t0 = Date.now();
    let booted = false;
    for (let i = 0; i < 80; i += 1) {
      const txt = await wc.executeJavaScript("document.body.innerText").catch(() => "");
      if (txt && !txt.includes("正在读取本地配置")) { booted = true; break; }
      await sleep(500);
    }
    console.log("[boot]", booted ? "ready in " + (Date.now() - t0) + "ms" : "STUCK after " + (Date.now() - t0) + "ms");
    const navs = await wc.executeJavaScript("[...document.querySelectorAll('.sidebar a, .sidebar button, aside button, aside a')].map(n => n.textContent.trim()).filter(Boolean)");
    console.log("[navs]", JSON.stringify(navs));
    for (const label of ["模组", "Java", "设置", "下载游戏", "实例"]) {
      const ok = await wc.executeJavaScript(`(async () => {
        const nodes = [...document.querySelectorAll('button, a')];
        const t = nodes.find(n => n.textContent.trim() === "${label}");
        if (!t) return false; t.click();
        await new Promise(r => setTimeout(r, 700)); return true;
      })()`).catch(() => false);
      if (!ok) { console.log("[nav-missing]", label); continue; }
      const info = await wc.executeJavaScript("({ text: document.body.innerText.replace(/\\s+/g,' ').slice(0,220) })").catch(() => null);
      console.log("[page:" + label + "]", JSON.stringify(info));
    }
    console.log("[done]");
    app.quit();
  });
});

require("../dist-electron/main/main.js");
setTimeout(() => { console.log("[hard-timeout]"); app.quit(); }, 120000);
