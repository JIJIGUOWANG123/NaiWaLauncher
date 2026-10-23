// 生成安装包：默认装到 C:\Program Files\naiwa，程序文件全部收在 <root>\main，
// 根目录只放 NaiWa Launcher.lnk（指向 main 里的 exe）与 Uninstall.exe；
// 游戏数据 <root>\.minecraft / <root>\NaiWa / servers / skins / capes 留在根目录，卸载保留。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
// electron-builder 在改名失败/中断时会把解包目录留成 win-unpacked.tmp，两个都认一下
const candidates = [process.env.NAIWA_UNPACKED, join(root, "release", "win-unpacked"), join(root, "release", "win-unpacked.tmp")]
  .filter(Boolean);
const unpacked = candidates.find((dir) => existsSync(join(dir, "NaiWa Launcher.exe"))) ?? candidates.find(Boolean);
// 有人直接跑过 win-unpacked 里的 exe 时，游戏数据会落在包目录里，必须在打包前剔除
for (const junk of [".minecraft", "NaiWa", "logs", "config", "meta", "downloads", "libraries", "versions", "assets", "instances", "java"]) {
  rmSync(join(unpacked, junk), { recursive: true, force: true });
}
if (!existsSync(join(unpacked, "NaiWa Launcher.exe"))) {
  console.error("缺少 release/win-unpacked（或 win-unpacked.tmp），请先执行: node scripts/build-app.mjs");
  process.exit(1);
}

const cache = join(homedir(), "AppData", "Local", "electron-builder", "Cache", "nsis-3.0.4.1");
let makensis = "";
let includeDir = "";
for (const name of readdirSync(cache)) {
  const bin = join(cache, name, "Bin", "makensis.exe");
  if (existsSync(bin)) { makensis = bin; includeDir = join(cache, name, "Include"); break; }
}
if (!makensis) { console.error("找不到 makensis：请先跑一次 electron-builder 打包"); process.exit(1); }

// 可用环境变量覆盖，便于在无 UAC 的环境里自检布局：
//   NAIWA_INSTALL_DIR  默认安装目录（默认 $PROGRAMFILES64\naiwa）
//   NAIWA_ELEVATE=user 降低权限要求（默认 admin）
const installDirVar = process.env.NAIWA_INSTALL_DIR || "$PROGRAMFILES64\\naiwa";
const elevate = (process.env.NAIWA_ELEVATE || "admin").toLowerCase() === "user" ? "user" : "admin";

const ico = join(root, "resources", "logo.ico");
// 固定名（GitHub Release 与自动更新都认这个名字，永远指向最新版）+ 带版本号的副本（便于归档）
const fixedOut = join(root, "release", "NaiWaLauncher-Setup.exe");
const versionedOut = join(root, "release", "NaiWaLauncher-Setup-" + version + ".exe");
const scriptPath = join(root, ".scratch", "installer.nsi");
mkdirSync(join(root, ".scratch"), { recursive: true });
const estimatedKb = Math.round(statSync(join(unpacked, "NaiWa Launcher.exe")).size / 1024) + 200000;

const L = [];
const add = (...xs) => L.push(...xs);
add("Unicode true",
  "SetCompressor /SOLID lzma",
  'Name "奶娃启动器 NaiWa Launcher"',
  'Caption "奶娃启动器 ' + version + ' 安装程序"',
  'OutFile "' + fixedOut + '"',
  'InstallDir "' + installDirVar + '"',
  "RequestExecutionLevel " + elevate,
  'BrandingText "奶娃启动器 · NaiWa Launcher · 开发者 奶龙"',
  "ShowInstDetails show",
  "",
  '!addincludedir "' + includeDir + '"',
  '!include "MUI2.nsh"',
  "",
  '!define MUI_ICON "' + ico + '"',
  '!define MUI_UNICON "' + ico + '"',
  "!define MUI_ABORTWARNING",
  '!define MUI_FINISHPAGE_RUN "$INSTDIR\\main\\NaiWa Launcher.exe"',
  '!define MUI_FINISHPAGE_RUN_TEXT "立即启动 NaiWa Launcher"',
  "",
  "!insertmacro MUI_PAGE_WELCOME",
  "!insertmacro MUI_PAGE_DIRECTORY",
  "!insertmacro MUI_PAGE_INSTFILES",
  "!insertmacro MUI_PAGE_FINISH",
  "!insertmacro MUI_UNPAGE_CONFIRM",
  "!insertmacro MUI_UNPAGE_INSTFILES",
  '!insertmacro MUI_LANGUAGE "SimpChinese"',
  "",
  "; 无论用户选哪个父目录，最终都落到 <父目录>\\naiwa",
  "Function AppendNaiwa",
  "; /S 静默安装（自动更新用）时按 /D= 指定目录原样安装，不再追加 \\naiwa",
  "  IfSilent done",
  '  StrCpy $1 "$INSTDIR" "" -6',
  '  StrCmp $1 "\\naiwa" +2',
  '  StrCpy $INSTDIR "$INSTDIR\\naiwa"',
  "  done:",
  "FunctionEnd",
  "",
  "Function .onVerifyInstDir",
  "  Call AppendNaiwa",
  "FunctionEnd",
  "",
  "; 旧平铺布局的清理动作：抽成宏，供首轮与失败的整组重试复用",
  "!macro NaiwaFlatPurge",
  '  Delete "$INSTDIR\\NaiWa Launcher.exe"',
  '  Delete "$INSTDIR\\Uninstall.exe"',
  '  Delete "$INSTDIR\\package.json"',
  '  Delete "$INSTDIR\\*.asar"',
  '  Delete "$INSTDIR\\*.dll"',
  '  Delete "$INSTDIR\\*.pak"',
  '  Delete "$INSTDIR\\*.bin"',
  '  Delete "$INSTDIR\\*.dat"',
  '  Delete "$INSTDIR\\*.ico"',
  '  Delete "$INSTDIR\\*.txt"',
  '  Delete "$INSTDIR\\*.html"',
  '  Delete "$INSTDIR\\LICENSE*"',
  '  RMDir /r "$INSTDIR\\resources"',
  '  RMDir /r "$INSTDIR\\locales"',
  "!macroend",
  "",
  'Section "Install"',
  '  SetShellVarContext all',
  '',
  '  ; ---- 安装前结束正在运行的本产品进程 ----',
  '  ; 旧平铺布局的 exe 就在 $INSTDIR 根目录，进程占用时 NSIS 的 Delete 会静默失败，',
  '  ; 留下「没有 resources 的旧 exe 空壳」，双击只会启动失败或跑回旧版。',
  '  ; 新布局下进程名同样是 NaiWa Launcher.exe（在 main\\ 里），安装前关掉启动器是预期行为。',
  '  ; 只按进程名精确匹配，不用通配，不涉及其他进程。',
  '  nsExec::Exec \'taskkill /IM "NaiWa Launcher.exe" /F\'',
  '  Pop $0 ; 必须 pop 掉返回值，否则 nsExec 会在栈上留残留',
  '  ; 进程退出到 Windows 真正释放文件句柄之间有延迟，先等 2 秒再删',
  '  Sleep 2000',
  '',
  '  ; ---- NAIWA 旧平铺布局迁移（0.2.6 及更早：程序文件与数据都在根目录）----',
  '  ; 只有确认根目录那份是「我们的平铺安装」时才清（用 resources\\app\\package.json 作标记），',
  '  ; 避免用户把启动器装进一个本来就有同名文件的目录时误删东西。',
  '  IfFileExists "$INSTDIR\\resources\\app\\package.json" naiwa_old_flat naiwa_flat_done',
  '  naiwa_old_flat:',
  '    !insertmacro NaiwaFlatPurge',
  '    ; 被占用的文件句柄释放可能慢一拍：还有残留就整组重试一次（只重试一次）',
  '    IfFileExists "$INSTDIR\\NaiWa Launcher.exe" naiwa_flat_retry naiwa_flat_check',
  '  naiwa_flat_check:',
  '    IfFileExists "$INSTDIR\\resources\\app\\package.json" naiwa_flat_retry naiwa_flat_done',
  '  naiwa_flat_retry:',
  '    Sleep 2000',
  '    !insertmacro NaiwaFlatPurge',
  '  naiwa_flat_done:',
  '',
  '  ; ---- 新版布局：程序进 main\\，数据（.minecraft / NaiWa / servers / skins / capes）留在根 ----',
  '  ; 程序文件全部进 <root>\\main，根目录只留快捷方式与卸载程序',
  '  SetOutPath "$INSTDIR\\main"',
  '  File /r "' + join(unpacked, "*.*") + '"',
  '  ; 数据写在 $INSTDIR 根目录（.minecraft / NaiWa / servers / skins / capes），必须给普通用户写权限',
  '  ExecWait \'"$SYSDIR\\icacls.exe" "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q\'',
  "",
  '  CreateShortcut "$INSTDIR\\NaiWa Launcher.lnk" "$INSTDIR\\main\\NaiWa Launcher.exe" "" "$INSTDIR\\main\\NaiWa Launcher.exe" 0',
  '  CreateDirectory "$SMPROGRAMS\\奶娃启动器"',
  '  CreateShortcut "$SMPROGRAMS\\奶娃启动器\\NaiWa Launcher.lnk" "$INSTDIR\\main\\NaiWa Launcher.exe" "" "$INSTDIR\\main\\NaiWa Launcher.exe" 0',
  '  CreateShortcut "$DESKTOP\\NaiWa Launcher.lnk" "$INSTDIR\\main\\NaiWa Launcher.exe" "" "$INSTDIR\\main\\NaiWa Launcher.exe" 0',
  '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
  "",
  '  WriteRegStr HKLM "Software\\NaiWaLauncher" "InstallLocation" "$INSTDIR"',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "DisplayName" "奶娃启动器 NaiWa Launcher"',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "DisplayVersion" "' + version + '"',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "Publisher" "奶龙"',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "DisplayIcon" "$INSTDIR\\NaiWa Launcher.lnk"',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "InstallLocation" "$INSTDIR"',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "UninstallString" \'"$INSTDIR\\Uninstall.exe"\'',
  '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "QuietUninstallString" \'"$INSTDIR\\Uninstall.exe" /S\'',
  '  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "NoModify" 1',
  '  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "NoRepair" 1',
  '  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher" "EstimatedSize" ' + estimatedKb,
  "SectionEnd",
  "",
  'Section "Uninstall"',
  '  SetShellVarContext all',
  '  Delete "$INSTDIR\\NaiWa Launcher.lnk"',
  '  Delete "$DESKTOP\\NaiWa Launcher.lnk"',
  '  Delete "$SMPROGRAMS\\奶娃启动器\\NaiWa Launcher.lnk"',
  '  RMDir "$SMPROGRAMS\\奶娃启动器"',
  '  ; 程序文件全在 main 子目录，整棵删掉；根目录的 .minecraft / NaiWa / servers / skins / capes 一律不动',
  '  RMDir /r "$INSTDIR\\main"',
  '  Delete "$INSTDIR\\Uninstall.exe"',
  '  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher"',
  '  DeleteRegKey HKLM "Software\\NaiWaLauncher"',
  "; 玩家数据留在 $INSTDIR 根目录：卸载只清程序，$INSTDIR 非空时最后的 RMDir 会静默失败，正是想要的效果",
  '  RMDir "$INSTDIR"',
  "SectionEnd",
);

writeFileSync(scriptPath, "\uFEFF" + L.join("\r\n"), "utf8");
console.log("makensis:", makensis);
execFileSync(makensis, ["/V2", scriptPath], { stdio: "inherit" });
console.log("installer(fixed):", fixedOut);
copyFileSync(fixedOut, versionedOut);
console.log("installer(versioned):", versionedOut);