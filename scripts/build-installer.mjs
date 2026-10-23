// 生成安装包：默认装到 C:\Program Files\naiwa，启动器文件平铺在该目录；
// 游戏数据 <root>\.minecraft 与启动器数据 <root>\NaiWa 首次启动时生成，卸载保留。
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
  '!define MUI_FINISHPAGE_RUN "$INSTDIR\\NaiWa Launcher.lnk"',
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
  'Section "Install"',
  '  SetShellVarContext all',
  '  SetOutPath "$INSTDIR"',
  '  File /r "' + join(unpacked, "*.*") + '"',
  '  ; Program Files 默认只读，但启动器把游戏数据放在程序同级目录，必须给普通用户写权限',
  '  ExecWait \'"$SYSDIR\\icacls.exe" "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q\'',
  "",
  '  CreateShortcut "$INSTDIR\\NaiWa Launcher.lnk" "$INSTDIR\\NaiWa Launcher.exe" "" "$INSTDIR\\NaiWa Launcher.exe" 0',
  '  CreateDirectory "$SMPROGRAMS\\奶娃启动器"',
  '  CreateShortcut "$SMPROGRAMS\\奶娃启动器\\NaiWa Launcher.lnk" "$INSTDIR\\NaiWa Launcher.exe"',
  '  CreateShortcut "$DESKTOP\\NaiWa Launcher.lnk" "$INSTDIR\\NaiWa Launcher.exe"',
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
  '  Delete "$INSTDIR\\Uninstall.exe"',
  '  ; 只删程序文件，保留 .minecraft 与 NaiWa 玩家数据',
  '  Delete "$INSTDIR\\*.exe"',
  '  Delete "$INSTDIR\\*.dll"',
  '  Delete "$INSTDIR\\*.pak"',
  '  Delete "$INSTDIR\\*.bin"',
  '  Delete "$INSTDIR\\*.dat"',
  '  Delete "$INSTDIR\\*.json"',
  '  Delete "$INSTDIR\\*.txt"',
  '  Delete "$INSTDIR\\*.html"',
  '  Delete "$INSTDIR\\*.ico"',
  '  Delete "$INSTDIR\\LICENSE*"',
  '  RMDir /r "$INSTDIR\\locales"',
  '  RMDir /r "$INSTDIR\\resources"',
  '  Delete "$DESKTOP\\NaiWa Launcher.lnk"',
  '  Delete "$SMPROGRAMS\\奶娃启动器\\NaiWa Launcher.lnk"',
  '  RMDir "$SMPROGRAMS\\奶娃启动器"',
  '  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NaiWaLauncher"',
  '  DeleteRegKey HKLM "Software\\NaiWaLauncher"',
  "; .minecraft 与 NaiWa 是玩家数据，卸载不删",
  '  RMDir "$INSTDIR"',
  "SectionEnd",
);

writeFileSync(scriptPath, "\uFEFF" + L.join("\r\n"), "utf8");
console.log("makensis:", makensis);
execFileSync(makensis, ["/V2", scriptPath], { stdio: "inherit" });
console.log("installer(fixed):", fixedOut);
copyFileSync(fixedOut, versionedOut);
console.log("installer(versioned):", versionedOut);