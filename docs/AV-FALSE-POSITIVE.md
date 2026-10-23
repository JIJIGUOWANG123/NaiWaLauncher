# 杀毒软件误报说明（供用户与申诉使用）

NaiWa Launcher 是开源的 Minecraft 启动器，用 Electron + TypeScript 编写，**没有加壳、没有混淆、没有 VMProtect / Themida 之类的保护**，
源码与全部构建脚本都在仓库里（`源代码/` 目录即完整源码快照）。如果被 Defender / 360 / 火绒等报毒，基本是**行为特征**而非真实恶意代码，
可按下面的信息提交误报。

## 程序会做什么（正常行为）

| 行为 | 用途 | 是否默认开启 |
|---|---|---|
| 下载游戏文件 | 从 Mojang / BMCLAPI / 镜像拉取版本、jar、资源、库 | 是（用户主动点「下载」时） |
| 启动 java 进程 | 运行 Minecraft（`spawn` + 参数数组传参，不拼命令行） | 是（用户点「启动」时） |
| 读写 `.minecraft`、`NaiWa` 目录 | 游戏数据与本启动器数据都放在程序同级目录 | 是 |
| 打开浏览器 / 资源管理器 | 「打开目录」「项目主页」等按钮 | 用户点击时 |
| 托盘图标 | 设置里开启「关闭到托盘」后，关闭窗口不退出 | **否**（用户手动开启） |
| 修改游戏进程优先级 / 窗口标题 | 通过一个隐藏的 PowerShell 一次性脚本操作**已经由本程序启动的**游戏进程 | **否**（设置项「高级进程操作」，默认关闭） |
| 注入 authlib-injector（javaagent） | 第三方（Yggdrasil）账号登录必需；离线本地皮肤也走这条路 | 第三方账号登录时必需；离线本地皮肤**默认关闭**（设置项「离线本地皮肤 API」） |
| 启动 frpc（樱花穿透） | 「联机」页的内网穿透，程序会按需下载官方 frpc 并运行 | **否**（用户手动点「启动隧道」） |
| 覆盖自身 exe 完成自动更新 | 下载新版后由脚本替换程序文件并重启 | 用户点「立即更新」时 |

## 程序**不会**做（若杀软声称有，请以本仓库源码为准）

- 不读浏览器 cookie / 密码库 / 剪贴板历史（仅「复制链接」时写入剪贴板）
- 不采集键盘输入、不截屏、不上传用户文件
- 不修改系统设置、不写注册表启动项（安装包只写卸载信息 `HKLM\Software\NaiWaLauncher` 与本产品自己的 Uninstall 键）
- 不加载外部 DLL、不做进程注入（除上述可关闭的 javaagent 场景）
- 不打包任何第三方可疑二进制；frpc 由用户触发时从官方地址下载

## 构建设置（可复核）

- `asar: false`：应用文件以明文目录分发，**没有加壳/打包压缩**，任何人都能直接看到 `dist-electron`、`dist` 与 `package.json`
- exe 的版本信息齐全：FileDescription / ProductName / CompanyName / FileVersion / ProductVersion / LegalCopyright（右键属性 → 详细信息可见）
- 单文件便携版（`-single-exe.exe`）本质是 **7-Zip 自解压**，这类「自解压」结构容易被启发式判为可疑；如果遇到误报，**优先使用 `Setup` 安装版或 `portable-x64.zip`**，它们不含自解压壳。

## 提交误报

- Microsoft Defender：<https://www.microsoft.com/en-us/wdsi/filesubmission>（选「Software developer」可加急）
- 360 / 火绒 / 腾讯电脑管家：各自官网的「误报申诉」入口，提交 exe 与本文说明
- 说明要点：开源项目地址、无壳无混淆、行为清单（上面表格）、版本信息完整、可选功能默认关闭

## 项目信息

- 仓库：<https://github.com/JIJIGUOWANG123/NaiWaLauncher>
- 完整源码快照：仓库根目录 `源代码/`
- 更新日志：`CHANGELOG.md`（程序「关于」页也会展示最新版本内容）
