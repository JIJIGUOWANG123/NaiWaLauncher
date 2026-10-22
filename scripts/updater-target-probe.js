const { app } = require("electron");
const path = require("node:path");
app.whenReady().then(() => {
  const mod = require(path.join(__dirname, "..", "dist-electron", "main", "core", "updater.js"));
  const cases = [];
  // 1) 无 PORTABLE_EXECUTABLE_FILE（开发态/安装版模拟）
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  cases.push(["no-env", mod.updateTarget(), mod.canSelfUpdate()]);
  // 2) portable 运行：外置 exe 在 D 盘，进程在 temp
  process.env.PORTABLE_EXECUTABLE_FILE = "D:\\Apps\\NaiWaLauncher.exe";
  cases.push(["portable", mod.updateTarget(), mod.canSelfUpdate()]);
  // 3) 安装版（Program Files）
  process.env.PORTABLE_EXECUTABLE_FILE = "C:\\Program Files\\naiwa\\NaiWa Launcher.exe";
  cases.push(["installed", mod.updateTarget(), mod.canSelfUpdate()]);
  for (const [name, target, can] of cases) console.log("[case]", name, "→ target=" + target, "canSelfUpdate=" + can, "| procExe=" + app.getPath("exe"));
  app.quit();
});
setTimeout(() => app.quit(), 15000);
