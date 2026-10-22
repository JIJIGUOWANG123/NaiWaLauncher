; 奶娃启动器安装脚本定制
; 目标：无论用户把安装路径选在哪，最终程序都落在 <自选路径>\naiwa（便携布局：游戏数据与程序同级）。
; electron-builder 的 assistedInstaller.nsh 在目录页 leave 时会追加 ${APP_FILENAME}，
; 但静默安装（/S /D=...）不经过目录页，所以这里在 customInit 再做一次兜底，两种方式都成立。
!undef APP_FILENAME
!define APP_FILENAME "naiwa"

!macro customHeader
  BrandingText "奶娃启动器 · NaiWa Launcher · 开发者 奶龙"
!macroend

!macro customInit
  ; 若 $INSTDIR 已以 \naiwa 结尾则不重复追加（目录页 leave 也会做同样的判断）
  StrCpy $1 "$INSTDIR" "" -6
  StrCmp $1 "\naiwa" +2
  StrCpy $INSTDIR "$INSTDIR\naiwa"
!macroend
