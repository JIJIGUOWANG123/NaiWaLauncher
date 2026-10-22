const { app, BrowserWindow, session } = require("electron");
const seen = new Set();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://api.minekuai.cn/*", "*://api.liuliyue.cn/*"] }, (details, cb) => {
    const u = details.url;
    if (!seen.has(u.split("?")[0])) { seen.add(u.split("?")[0]); console.log("[req]", details.method, u.slice(0, 200)); }
    cb({});
  });
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try { await win.loadURL("https://bbs.minekuai.com/resources"); } catch (e) { console.log("[load-err]", String(e).slice(0, 100)); }
  await new Promise((r) => setTimeout(r, 12000));
  console.log("[captured]", seen.size);
  app.quit();
});
setTimeout(() => { console.log("[hard-timeout]"); app.quit(); }, 30000);
