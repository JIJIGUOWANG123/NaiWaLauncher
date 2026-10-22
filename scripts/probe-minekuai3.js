const { app, BrowserWindow, session } = require("electron");
const seen = new Set();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://api.minekuai.cn/*"] }, (d, cb) => {
    const u = d.url.split("?")[0];
    if (!seen.has(u) && !/site-config|site-visits|\/v2\//.test(u)) { seen.add(u); console.log("[req]", u, "| q:", (d.url.split("?")[1] || "").slice(0, 80)); }
    cb({});
  });
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  for (const p of ["https://bbs.minekuai.com/resources/maps"]) {
    try { await win.loadURL(p); } catch (e) {}
    await new Promise((r) => setTimeout(r, 9000));
  }
  console.log("[done]");
  app.quit();
});
setTimeout(() => app.quit(), 30000);
