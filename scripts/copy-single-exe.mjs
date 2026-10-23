// 自更新用的是 Release 里不带版本号的 NaiWaLauncher.exe：这里把刚打好的
// NaiWaLauncher-<version>-single-exe.exe 复制一份成该名字，省掉手工改名。
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const from = join(root, "release", "NaiWaLauncher-" + version + "-single-exe.exe");
const to = join(root, "release", "NaiWaLauncher.exe");

if (!existsSync(from)) {
  console.error("缺少 " + from + "，请先执行: node scripts/build-app.mjs --win portable --x64");
  process.exit(1);
}
copyFileSync(from, to);
console.log("self-update asset:", to, (statSync(to).size / 1048576).toFixed(1) + "MB");
