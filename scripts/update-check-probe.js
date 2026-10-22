const { app } = require("electron");
const path = require("node:path");
const mod = require(path.join(__dirname, "..", "dist-electron", "main", "core", "updates.js"));
app.whenReady().then(async () => {
  console.log("[compare] 0.1.1<0.1.2:", mod.compareVersion("0.1.1", "0.1.2") < 0, "| 0.2.0>0.1.9:", mod.compareVersion("0.2.0", "0.1.9") > 0);
  const r = await mod.checkAppUpdates();
  console.log("[result]", JSON.stringify(r));
  app.quit();
});
setTimeout(() => app.quit(), 45000);
