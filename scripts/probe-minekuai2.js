const { app, BrowserWindow, session } = require("electron");
const seen = new Set();
const pages = ["https://bbs.minekuai.com/resources/shaders", "https://bbs.minekuai.com/resources/resourcepacks", "https://bbs.minekuai.com/resources/modpacks"];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://api.minekuai.cn/*"] }, (d, cb) => {
    const u = d.url.split("?")[0];
    if (!seen.has(u) && !/site-config|site-visits|images|\/v2\//.test(u)) { seen.add(u); console.log("[req]", u); }
    cb({});
  });
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  for (const p of pages) {
    try { await win.loadURL(p); } catch (e) {}
    await new Promise((r) => setTimeout(r, 6000));
  }
  console.log("[captured]", seen.size);
  app.quit();
});
setTimeout(() => { console.log("[hard-timeout]"); app.quit(); }, 45000);
