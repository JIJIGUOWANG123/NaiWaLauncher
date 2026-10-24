// 导出可直接推送到 GitHub 的源码快照：只拷贝源码与工程配置，排除运行期数据与构建产物。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "源代码");

const files = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
  "tsconfig.json", "tsconfig.main.json", "tsconfig.web.json", "vite.config.ts",
  "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "logo.png",
];
const dirs = ["src", "resources", "scripts", "docs", ".github"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let count = 0;
for (const f of files) {
  const from = join(root, f);
  if (!existsSync(from)) continue;
  cpSync(from, join(out, f));
  count += 1;
}
for (const d of dirs) {
  const from = join(root, d);
  if (!existsSync(from)) continue;
  cpSync(from, join(out, d), { recursive: true });
  count += 1;
}

const ignore = [
  "node_modules/", "backup/", "dist/", "dist-electron/", "release/", ".tools/", ".scratch/",
  ".minecraft/", "NaiWa/", "*.log", "Thumbs.db", ".DS_Store", ".ms-client-id", "",
].join("\n");
writeFileSync(join(out, ".gitignore"), ignore, "utf8");

console.log("source snapshot:", out);
console.log("copied entries:", count);
// statSync 对目录返回的是元数据大小（恒为 0），这里递归求和才是快照真实体积
const dirSize = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? dirSize(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0);
console.log("size:", (dirSize(out) / 1048576).toFixed(1) + " MB");