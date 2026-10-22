# 奶娃启动器 · NaiWa Launcher

<img src="logo.png" width="120" align="right" alt="NaiWa Launcher" />

现代化的 Minecraft 启动器（Windows x64）。程序显示名 **NaiWa Launcher**，设置内显示「奶娃启动器 / NaiWa Launcher」。

主开发者 **奶龙** ｜ 协助开发者 **小七** ｜ 工具提供 **DeepSeek**

> 源码仓库：<https://github.com/JIJIGUOWANG123/NaiWaLauncher> | 问题反馈：[Issues](https://github.com/JIJIGUOWANG123/NaiWaLauncher/issues)

- 多版本 / 多实例管理，按实例隔离模组与存档
- Fabric / Forge / NeoForge 安装与**一键切换**
- 下载源：官方 / BMCLAPI / 上海交大（仅依赖库）/ FastMinecraftMirror / 自动测速；镜像缺件或不可达自动回源
- 多线程下载、断点续传、全局限速
- Modrinth 完整支持；CurseForge 支持「自备 Key」与「无 Key 粘贴链接」两种模式
- BellSoft Liberica JDK 下载安装 + 本机 JDK 探测；**每个实例可单独指定 Java**，或由设置里的「自动匹配 Java 版本」按游戏版本挑选（以版本 JSON 的 javaVersion 为准；兜底 ≤1.16.5→8、1.17–1.20.4→17、1.20.5–1.25→21、26.x 起→25）
- **前置依赖检查**：安装前解析 Modrinth / CurseForge 的必需前置，已在实例里的标「已安装」，缺失的可一键一并安装；本体会维护安装索引避免重复下载
- **存档直进**：实例里可列出现有单人存档（图标/大小/时间），点「进入」直接加载；也能一键新建存档并直接进入（1.20+ 的 quickPlay）
- 实例级模组管理：列表、检查更新、更新、删除，文件名模板可自定义
- 模组详情面板：点击即看简介、完整介绍、分类/版本/加载器、画廊、许可与项目主页，可直接安装到当前实例
- **中文搜索与实时翻译**（DeepL → uapis.cn → suapi.net 自动主备切换，全部失败则显示原文）：输入中文（如「钠 优化」）先译为英文再检索；结果标题/简介实时回译成中文（走 uapis.cn 免费接口，带 7 天本地缓存与限流保护，可在设置里关闭）
- 离线账号 / 微软正版账号（设备码登录）
- 个性化：**自绘标题栏**（精简 / 图片两种，均可自定义标题文字，系统标题栏已移除）；**整套换肤**（背景/面板/边框/三级文字色/侧边栏全跟着变，明暗主题各自成套）+ 自定义取色（自定义主题支持渐变）、透明度、背景图（单张 / 顺序轮播 / 随机轮播）、背景音乐
- 启动时 logo 淡入 → 渐变消失；游戏内默认简体中文

## 截图

| 实例 | 模组商店 | 实例详情（模组管理 / 加载器切换） |
|---|---|---|
| ![](docs/images/instances.png) | ![](docs/images/mods.png) | ![](docs/images/instance-detail.png) |

| 账号 | 个性化 | 启动选项 | 其它设置 |
|---|---|---|---|
| ![](docs/images/accounts.png) | ![](docs/images/personalize.png) | ![](docs/images/launch-settings.png) | ![](docs/images/other-settings.png) |

## 安装

1. 运行 `NaiWaLauncher-Setup-<version>.exe`（需要管理员权限，会弹出 UAC）
2. 安装位置默认 **`C:\Program Files\naiwa`**，也可以改成任意目录（安装器会在其下创建 `naiwa` 文件夹）
3. 安装完成后桌面/开始菜单会有「NaiWa Launcher」快捷方式

安装后的目录（启动器文件平铺，游戏与配置首次启动时生成）：

```
C:\Program Files\naiwa\
  NaiWa Launcher.exe      启动器（快捷方式指向它）
  resources\ locales\ *.dll …   Electron 运行时
  Uninstall.exe
  .minecraft\             游戏数据：versions / libraries / assets / instances
  NaiWa\                  启动器数据：config / logs / meta / downloads / java / backgrounds / music
```

> 因为数据与程序同级，而 `Program Files` 默认只读，安装器会在安装结束时给该目录加「Users 可修改」权限（`icacls`）；卸载不会删除 `.minecraft` 与 `NaiWa`。
> 安装器不再读取旧的注册表安装路径（曾导致静默安装落到错误目录）。

### 免安装压缩包

不想安装时用 `NaiWaLauncher-<version>-portable-x64.zip`：解压到任意可写目录得到 `naiwa` 文件夹，双击 `naiwa\NaiWa Launcher.exe` 即用（无需管理员权限）。解压包内附 `使用说明.txt`；把整个 `naiwa` 文件夹拷走即可带走全部数据。

## 账号

| 类型 | 说明 |
|---|---|
| 离线账号 | 输入 3–16 位字母/数字/下划线即可玩单人游戏与离线服 |
| 微软正版 | 设备码登录。**需要自备 Azure 应用 client id**（重定向类型选「公共客户端」，API 权限勾选 `XboxLive.signin`），填在「账号 → 微软账号」里 |

> 项目不内置 CurseForge Key。
>
> **关于微软登录**：
> 内置公共 client id 为 `fd3e219a-6e6a-4188-8a39-e241f0e63324`（可在「账号」页的输入框替换：**留空即用内置，填了就完全不再使用内置**）。设备码流程实测可正常返回 `user_code`；最终 `login_with_xbox` 是否通过取决于该 Azure 应用是否已获 Mojang 认可。
>
>代码已实现完整链路（设备码 → XBL → XSTS → Minecraft 令牌 → 档案）。实测 OAuth/XBL/XSTS 三段均通过，但 Minecraft 服务端会校验发起请求的 Azure 应用是否通过 **AppID 审批**（`aka.ms/AppRegInfo` → [help.minecraft.net 申请页](https://help.minecraft.net/hc/en-us/articles/16254801392141)），未审批的应用在 `login_with_xbox` 返回 `403 Invalid app registration`。默认 client id 为 `fd3e219a-6e6a-4188-8a39-e241f0e63324`，可在账号页替换；审批通过后无需改代码。
>
> 未通过审批前，离线账号功能完全可用，但无法进入正版验证服务器。

## CurseForge 的两种用法

| 场景 | 能力 |
|---|---|
| 填了 API Key | 官方 API 全功能：关键词搜索、文件列表、检查更新、安装 |
| 不填 Key（默认） | 无 Key 模式：粘贴模组链接（如 `https://www.curseforge.com/minecraft/mc-mods/jei`）或项目 ID 即可解析并安装；**不支持关键词搜索**，下载走 forgecdn CDN（无哈希，只校验字节数） |

## 数据源

| 用途 | 地址 |
|---|---|
| 官方版本清单 | launchermeta.mojang.com / piston-meta.mojang.com |
| 镜像（整站） | bmclapi2.bangbang93.com（文档 bmclapidoc.bangbang93.com） |
| 镜像（仅依赖库） | mirror.sjtu.edu.cn/bmclapi（上海交大） |
| 镜像（分域名） | fastmcmirror.org（launchermeta / libraries / resources / forge / fabric 各自子域；本机偶发不可达，启动器会自动跳过并回退） |
| 模组 | api.modrinth.com / api.curseforge.com（可选 Key）/ api.cfwidget.com（无 Key 模式） |
| Java | BellSoft Liberica（download.bell-sw.com 优先，GitHub 兜底） |

## 开发

```powershell
pnpm install
pnpm typecheck        # 主进程 + 渲染进程类型检查
pnpm build            # tsc 主进程 + vite 构建渲染进程
pnpm dev              # 渲染进程 http://localhost:5273
$env:NAIWA_DEV_URL="http://localhost:5273"; pnpm start   # 另开终端跑 Electron

pnpm dist             # 打包：electron-builder --dir + 自研 NSIS 安装包
```

技术栈：Electron 38 + React 19 + TypeScript(strict) + Vite 7；主进程与渲染进程通过 `preload` 暴露的 `window.naiwa` 通信，契约集中在 `src/shared/{types,ipc}.ts`。架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 已知限制

- 仅 Windows x64；未做代码签名，首次运行可能有 SmartScreen 提示。
- 无 Key 模式的 CurseForge 只能按链接/ID 精确取项目，且没有哈希校验。
- 微软账号未在本仓库通过真实 client id 端到端验证（端点与错误路径均已实测）。
- 切换「版本隔离」不会自动迁移已有模组目录。
- 离线皮肤、整合包导入、自动更新尚未实现。

## 许可

MIT，见 [LICENSE](LICENSE)。开发者：**奶龙**。

## 产物

| 文件 | 说明 |
|---|---|
| `NaiWaLauncher-Setup-<版本>.exe` | 安装包（默认装到 `C:\Program Files\naiwa`） |
| `NaiWaLauncher-<版本>-portable-x64.zip` | 免安装压缩包（解压即用） |
| `NaiWaLauncher.exe`（免安装版） | 单文件免安装版，**自更新用的就是这个**，Release 里请保持此文件名（不带版本号） |

## 产物

| 文件 | 说明 |
|---|---|
| `NaiWaLauncher-Setup-<版本>.exe` | 安装包（默认装到 `C:\Program Files\naiwa`） |
| `NaiWaLauncher-<版本>-portable-x64.zip` | 免安装压缩包（解压即用） |
| `NaiWaLauncher.exe` | 单文件免安装版，**自更新用的就是这个**；Release 里请保持此文件名（不带版本号） |

