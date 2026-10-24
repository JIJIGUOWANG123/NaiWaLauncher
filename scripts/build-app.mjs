// 打包：build → 清理陈旧 unpacked → electron-builder（默认 --win --dir，可用参数覆盖）。
// 为什么需要这个脚本：electron-builder 26 在打包前会调用 PATH 里的 pnpm 收集生产依赖，
// 机器上没把 pnpm 加进 PATH 时它拿到的是「命令找不到」的错误文本，于是报
// "No JSON content found in output" 直接失败。这里先找一个能用的 pnpm，
// 写个 shim 目录插到 PATH 最前面，再交给 electron-builder。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = join(root, ".scratch");
const shimDir = join(scratch, "bin");
const isWin = process.platform === "win32";

function log(msg) {
  console.log("[build-app] " + msg);
}

/** 按「显式环境变量 → 本地 .bin → PATH → 与本 node 同级的 pnpm → 用户目录」找 pnpm。 */
function findPnpm() {
  const explicit = process.env.NAIWA_PNPM;
  if (explicit && existsSync(explicit)) return explicit;

  for (const name of isWin ? ["pnpm.cmd", "pnpm.exe"] : ["pnpm"]) {
    const local = join(root, "node_modules", ".bin", name);
    if (existsSync(local)) return local;
  }

  const probe = isWin
    ? spawnSync("where", ["pnpm"], { encoding: "utf8" })
    : spawnSync("which", ["pnpm"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = String(probe.stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  }

  // 便携运行时（如 DSH 自带 node）里 pnpm 与 node 是同级目录：<deps>\node\bin\node.exe ↔ <deps>\pnpm\bin\pnpm.mjs
  const bundled = join(dirname(process.execPath), "..", "..", "pnpm", "bin", "pnpm.mjs");
  if (existsSync(bundled)) return bundled;

  const home = process.env.LOCALAPPDATA;
  if (home) {
    const p = join(home, "pnpm", isWin ? "pnpm.exe" : "pnpm");
    if (existsSync(p)) return p;
  }
  return "";
}

/** 把找到的 pnpm 落成 PATH 上可直接执行的 pnpm：真正可执行的直接复制，脚本则包一层。 */
function ensureShim(pnpmPath) {
  rmSync(shimDir, { recursive: true, force: true });
  mkdirSync(shimDir, { recursive: true });
  const lower = pnpmPath.toLowerCase();

  if (lower.endsWith(".mjs") || lower.endsWith(".js") || lower.endsWith(".cjs")) {
    const cmd = '@echo off\r\n"' + process.execPath + '" "' + pnpmPath + '" %*\r\n';
    writeFileSync(join(shimDir, "pnpm.cmd"), cmd, "utf8");
    if (!isWin) {
      const sh = '#!/bin/sh\nexec "' + process.execPath + '" "' + pnpmPath + '" "$@"\n';
      writeFileSync(join(shimDir, "pnpm"), sh, "utf8");
      chmodSync(join(shimDir, "pnpm"), 0o755);
    }
    return "shim(node " + pnpmPath + ")";
  }

  // 已经是可执行文件（.exe/.cmd）：复制一份到 shim 目录，避免依赖它原本所在目录在 PATH 里
  const name = isWin ? "pnpm.cmd" : "pnpm";
  const text = isWin
    ? '@echo off\r\n"' + pnpmPath + '" %*\r\n'
    : '#!/bin/sh\nexec "' + pnpmPath + '" "$@"\n';
  writeFileSync(join(shimDir, name), text, "utf8");
  if (!isWin) chmodSync(join(shimDir, name), 0o755);
  return "shim(" + pnpmPath + ")";
}

function run(cmd, args, env) {
  log("$ " + cmd + " " + args.join(" "));
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
}

// 1) 前端与主进程产物
run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.main.json"], process.env);
run(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build"], process.env);

// 1.5) 内置 Microsoft client id：源码里是占位符，这里用仓库根目录的 .ms-client-id（未入库）注入到编译产物。
//      这样别人拿到的源码快照里没有这个 id，而发行版仍然内置它。
const clientIdFile = join(root, ".ms-client-id");
const settingsOut = join(root, "dist-electron", "main", "core", "settings.js");
if (existsSync(clientIdFile) && existsSync(settingsOut)) {
  const raw = readFileSync(clientIdFile, "utf8");
  /** 本地文件的格式：第一行是 client id，可选的第二行 DEEPL_KEY=... 是翻译 Key。 */
  const lines = raw.split(/\r?\n/);
  const clientId = (lines.find((line) => line.trim() && !line.includes("=")) ?? "").trim();
  const deeplKey = (lines.find((line) => /^DEEPL_KEY\s*=/.test(line)) ?? "").split("=")[1]?.trim() ?? "";
  let text = readFileSync(settingsOut, "utf8");
  const before = text;
  if (clientId) text = text.split("__NAIWA_MS_CLIENT_ID__").join(clientId);
  if (deeplKey) text = text.split("__NAIWA_DEEPL_API_KEY__").join(deeplKey);
  if (text !== before) {
    writeFileSync(settingsOut, text, "utf8");
    log("已把内置凭据注入编译产物（client id " + (clientId ? "有" : "无") + " · DeepL Key " + (deeplKey ? "有" : "无") + "），源码不含这些值");
  } else {
    log("提示：编译产物里没有占位符，跳过凭据注入");
  }
} else if (!existsSync(clientIdFile)) {
  log("提示：没找到 .ms-client-id，发行版将不内置 client id 与 DeepL Key（用户需自己填）");
}

// 2) 上一次中断留下的 win-unpacked.tmp(.lock) 会让 electron-builder 卡在改名步骤，目标目录也一起清掉：
//    它每次都整份重新解包，留着旧目录只会在 Windows 上把 rename 顶住。
for (const stale of ["win-unpacked.tmp", "win-unpacked.tmp.lock", "win-unpacked"]) {
  rmSync(join(root, "release", stale), { recursive: true, force: true });
}

// 3) 给 electron-builder 准备 pnpm
const pnpm = findPnpm();
const env = { ...process.env };
if (pnpm) {
  log("pnpm: " + ensureShim(pnpm));
  env.PATH = shimDir + ";" + (process.env.PATH ?? "");
} else {
  log("警告：没找到 pnpm，electron-builder 收集依赖时可能报 No JSON content found（可用 NAIWA_PNPM 指定 pnpm 路径）");
}

// 4) 打包：默认 dir 形态（安装包与 zip 都基于它），额外参数可透传给 electron-builder
// 打 portable 前先改造自解压桩：解压过一次的目录要复用，否则每次双击都要解压 300MB
if (process.argv.slice(2).includes("portable")) {
  const { patchPortableTemplate } = await import("./patch-portable-template.mjs");
  patchPortableTemplate(log);
}

const extra = process.argv.slice(2);
const targets = extra.length > 0 ? extra : ["--win", "--dir"];
run(process.execPath, [join(root, "node_modules", "electron-builder", "cli.js"), ...targets], env);
log("electron-builder 完成：" + targets.join(" "));