// electron-builder 的 portable 桩每次启动都 RMDir + 重新解压（templates/nsis/portable.nsi:38 与 :90），
// 300MB 的包因此每次双击都要几秒。这里在打包前把模板改成「首次解压、之后复用，版本变了才重解」。
// 只改 node_modules 里的模板文本，幂等；找不到预期结构时不修改并警告，绝不半途打补丁。
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export const MARK = "NAIWA_CACHED_EXTRACT";

export function patchPortableTemplate(log = console.log) {
  // app-builder-lib 不是直接依赖（pnpm 下挂在 .pnpm 里），先按 electron-builder 的解析路径找，
  // 再退到扫描 node_modules/.pnpm/app-builder-lib@*/。
  let templatePath = "";
  try {
    const fromElectronBuilder = { paths: [dirname(require.resolve("electron-builder/package.json"))] };
    const pkg = require.resolve("app-builder-lib/package.json", fromElectronBuilder);
    templatePath = join(dirname(pkg), "templates", "nsis", "portable.nsi");
  } catch {
    try {
      const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
      const match = readdirSync(pnpmDir).filter((name) => name.startsWith("app-builder-lib@")).sort().pop();
      if (match) {
        templatePath = join(pnpmDir, match, "node_modules", "app-builder-lib", "templates", "nsis", "portable.nsi");
      }
    } catch {
      templatePath = "";
    }
  }
  if (!templatePath || !existsSync(templatePath)) {
    log("[patch-portable] 找不到 app-builder-lib 模板，跳过（便携版仍会每次解压）");
    return false;
  }
  const original = readFileSync(templatePath, "utf8");
  if (original.includes(MARK)) {
    log("[patch-portable] 模板已打过补丁");
    return true;
  }

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);

  // 1) 第一次出现、且不是缩进为 tab 的那一行 RMDir，就是解压前的清理
  const rmIndex = lines.findIndex((line) => line.trim() === "RMDir /r $INSTDIR" && !line.startsWith("\t"));
  const envIndex = lines.findIndex((line) => line.includes("PORTABLE_EXECUTABLE_DIR"));
  const tailRmIndex = lines.findIndex((line, index) => index > envIndex && line.trim() === "RMDir /r $INSTDIR");
  if (rmIndex < 0 || envIndex < 0 || tailRmIndex < 0) {
    log("[patch-portable] 模板结构与预期不符，跳过补丁（便携版仍会每次解压）");
    return false;
  }

  // 2) 解压前插入「有同版本缓存就跳过」的守卫
  const guard = [
    "  ; [" + MARK + "] 同版本已解压过就直接复用：跳过删除与解压",
    '  IfFileExists "$INSTDIR\\.naiwa-portable" 0 naiwa_extract',
    '  ReadINIStr $R1 "$INSTDIR\\.naiwa-portable" "cache" "version"',
    '  StrCmp $R1 "${VERSION}" naiwa_skip naiwa_extract',
    "  naiwa_extract:",
  ];

  // 3) 解压完成后写版本标记，并在这里放 skip 标签（跳过时直接到这里）
  const marker = [
    '  WriteINIStr "$INSTDIR\\.naiwa-portable" "cache" "version" "${VERSION}"',
    "  naiwa_skip:",
  ];

  // 4) 退出时不再删除缓存目录（原第 :90 行）
  const tailComment = ["\t; [" + MARK + "] 保留解压缓存，下次启动直接复用"];

  const out = [
    ...lines.slice(0, rmIndex),
    ...guard,
    ...lines.slice(rmIndex, envIndex),
    ...marker,
    ...lines.slice(envIndex, tailRmIndex),
    ...tailComment,
    ...lines.slice(tailRmIndex + 1),
  ];

  const patched = out.join(eol);
  if (patched === original) {
    log("[patch-portable] 修改未生效，跳过（便携版仍会每次解压）");
    return false;
  }
  writeFileSync(templatePath, patched, "utf8");
  log("[patch-portable] 已改造便携桩：首次解压、之后复用缓存（版本变化才重解）");
  return true;
}

if (process.argv[1] && process.argv[1].endsWith("patch-portable-template.mjs")) {
  patchPortableTemplate();
}