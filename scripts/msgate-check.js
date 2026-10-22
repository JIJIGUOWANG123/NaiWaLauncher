// 校验：自定义 client id 留空时，「使用微软账号登录」按钮必须可点击，且输入框为空
const { app } = require("electron");
app.on("browser-window-created", (_e, win) => {
  const wc = win.webContents;
  wc.on("console-message", (_ev, level, message) => { if (level >= 2 && !/Security Warning/.test(String(message))) console.log("[renderer-error]", String(message).slice(0, 160)); });
  wc.on("did-finish-load", async () => {
    if (!wc.getURL().startsWith("file:")) return;
    await new Promise((r) => setTimeout(r, 2500));
    await wc.executeJavaScript("(async () => { const n=[...document.querySelectorAll(\"button,a\")].find(x=>x.textContent.trim()===\"账号\"); if(n) n.click(); })()").catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const info = await wc.executeJavaScript("(async () => { const btns=[...document.querySelectorAll(\"button\")]; const login=btns.find(b=>b.textContent.trim()===\"使用微软账号登录\"); const inputs=[...document.querySelectorAll(\"input\")]; const idInput=inputs.find(i=>(i.placeholder||\"\").includes(\"client id\")); return { found: !!login, disabled: login ? login.disabled : null, value: idInput ? idInput.value : null, placeholder: idInput ? idInput.placeholder : null, hintNext: login && login.nextElementSibling ? login.nextElementSibling.textContent.trim().slice(0,40) : \"\" }; })()").catch((e) => ({ error: String(e).slice(0, 120) }));
    console.log("[probe]", JSON.stringify(info));
    app.quit();
  });
});
require("../dist-electron/main/main.js");
setTimeout(() => { console.log("[hard-timeout]"); app.quit(); }, 60000);
