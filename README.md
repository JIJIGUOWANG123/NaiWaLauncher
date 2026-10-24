# 奶娃启动器 · NaiWa Launcher

<img src="logo.png" width="120" align="right" alt="NaiWa Launcher" />

现代化的 Minecraft 启动器（Windows x64）。程序显示名 **NaiWa Launcher**，界面内显示「奶娃启动器 / NaiWa Launcher」。当前版本 **0.4.3**。

主开发者 **奶龙** ｜ 协助开发者 **小七** ｜ 工具提供 **DeepSeek**

> 源码仓库：<https://github.com/JIJIGUOWANG123/NaiWaLauncher> ｜ 问题反馈：[Issues](https://github.com/JIJIGUOWANG123/NaiWaLauncher/issues) ｜ 更新日志：[CHANGELOG.md](CHANGELOG.md)

## 功能

### 游戏与实例
- 多版本 / 多实例管理，按实例隔离模组与存档；Fabric / Forge / NeoForge / Quilt / LiteLoader 安装与**一键切换**
- **存档直进**：列出现有单人存档（图标/大小/时间），点「进入」直接加载；也能新建存档并直接进入（1.20+ 的 quickPlay）
- 实例级内容管理：模组 / 光影包 / 资源包各自列表、检查更新、更新、删除（光影与资源包读 pack.mcmeta 说明），文件名模板可自定义；可搜索已装资源并单独删除
- **同时运行实例数**可设：默认只允许开一个，避免连点把内存吃满；需要多开改成「无限」
- **信任 Windows 证书库**开关：开启后给游戏 JVM 追加 `-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT`，让 Java 读系统根证书——专治「装了 HTTPS 代理后正版验证/皮肤/下载全部 PKIX 失败」；默认关，且不会覆盖你自己写的 `trustStore` 参数
- **游戏内存优化**开关：开启后追加面向低延迟的 G1GC 参数（Aikar 风格），关掉只下发 `-Xms/-Xmx`；实例里的「额外 JVM 参数」始终最高优先

### 下载与资源
- 下载源：官方 / BMCLAPI / 上海交大（仅依赖库）/ FastMinecraftMirror / 自动测速；镜像缺件或不可达自动回源
- 多线程下载、**断点续传（关闭软件后重启会接着已下载的部分继续，进度与字节数持久化）**、全局限速
- **下载统一在「管理」页查看**：实时速度、已下载 / 总大小、失败原因，以及继续 / 终止 / 移除 / 清空已完成
- **可以同时安装多个模组**（排队进行）：真正同时下载的数量在「其它」页设置（**默认 8**，范围 1–32），超出部分排队等待；同页还能调单文件分片连接数与速度限制（设置页不再重复放这些项）
- **GitHub 加速下载**（「其它」页顶部）：粘贴 GitHub 地址即可加速下载，**七个节点**可选 —— `ghf.无名氏.top` / `gh.padao.fun` / `ghfast.top` / `github.cnxiaobai.com` / `git.tangbai.cc` / `github.chenc.dev` / `30006000.xyz`
  - 默认**自动测速挑最快**，也可手动锁定某个节点，界面显示各节点实测延迟；**其中 3 个节点还能代理 GitHub API**（下拉里标「· API」），检查更新优先用它们
  - **Java 下载也用这套加速**：Adoptium 等 GitHub 源会按节点候选链依次尝试，全部失败才落原始地址
  - 文件默认存到 **`<启动器根目录>\DL`**，可自行指定目录；重名自动加 `(1)`
  - 下载进度显示在「管理」页（与游戏/整合包下载同一套任务列表），可取消、可继续
- **资源列表改为翻页**：每页 **10 个**（两列 × 5 行），底部「上一页 / 页码 / 下一页」（页码最多显示 5 个），**不再自动无限加载**，长列表也不会把界面拖卡
- **可以装到服务端**：点安装会弹出「安装到…」窗口，分**实例**与**服务端**两组（**插件**只列服务端、**模组**两组都列，整合包/资源包/光影只列实例）——**插件**进 `plugins`、**模组**进 `mods`；会按服务端核心判断能否安装（Paper/Purpur/Folia 等插件服、Fabric/Forge/NeoForge 模组服、Arclight 混合端、Vanilla 都不行），并读取 Modrinth 的 `server_side` 判断模组是否支持服务端
- **插件类型**：麦块社区与 Modrinth 支持，CurseForge 置灰；装到插件服时还会校核文件平台（Velocity 的文件装到 Paper 服会提示）
- **详情图集可点开大图**：滚轮缩放 1x–4x、放大后拖动平移、双击复位、← → 切换、Esc 关闭
- **选中目标就直接装**：已选好实例/服务端时，点卡片按钮直接安装；没选才弹出「安装到…」
- **详情自动翻译**：简介与完整介绍都会给中文译文，可切「译文 / 原文」；翻译不可用时直接显示原文，不报错
- Modrinth 完整支持；CurseForge 支持「自备 Key」与「无 Key 粘贴链接」两种模式
- **前置依赖检查**：安装前解析必需前置（模组 / 光影包 / 资源包都查），已装的标「已安装」，缺失的可一键一并安装；光影按加载器规则补（Fabric/Quilt/NeoForge → Iris，Forge → Oculus）
- **中文搜索与实时翻译**（DeepL → uapis.cn → suapi.net 自动主备切换）：输入中文先译英文再检索，结果标题/简介实时回译（7 天本地缓存，可关闭）

### Java
- **五个 JDK 下载源 + 自动测速**：BellSoft Liberica / Adoptium (Temurin) / 清华 TUNA 镜像 / **Azul Zulu** / **Oracle JDK**（Dragonwell 源已按需求移除；以前装过的仍能识别来源并正常使用）
- **已装 JDK 可卸载**：只允许卸载启动器自己装的（在 `NaiWa/java/` 下），路径不在该目录会被拒绝，被游戏占用时给出可读提示，卸载前会提示有多少实例在用；**系统安装的 JDK** 不提供卸载，改为「打开目录」按钮
  - Oracle JDK 来自第三方镜像（`d10.injdk.cn`），**不参与自动测速**、只在手动选择时出现，并在界面标注其官方许可提示
  - 自动模式会在余下几个源里测速挑最快（本机实测常见为清华 TUNA 或 Zulu）
  - 下载后都会校验（Zulu/Oracle 按镜像给出的体积、Dragonwell 有官方 sha256 侧车），解压到 `NaiWa/java/<source>-<major>-<version>`
- 已装 JDK **来源识别**（标记文件 → 目录名前缀 → JDK 自带 release 文件 → 判定为系统安装），列表里显示来源徽标
- 每个实例可单独指定 Java；也可用「自动匹配 Java 版本」按游戏版本挑选（以版本 JSON 的 javaVersion 为准；兜底 ≤1.16.5→8、1.17–1.20.4→17、1.20.5–1.25→21、26.x 起→25）

### 账号
- 离线账号 / 微软正版账号（设备码登录）/ 第三方 Yggdrasil（authlib-injector）

### 皮肤与披风
- **本地皮肤/披风**：`NaiWa/skins`、`NaiWa/capes` 下放图片即可给离线账号使用（不必上传到皮肤站）；实例内可不装模组生效（可选本地皮肤 API）
- **内置皮肤/披风**：随程序分发的只读资源（`resources/skins`、`resources/capes`），界面里只能应用不能修改
- **微软正版**：只**显示**当前在用的官方皮肤与披风，**不提供修改**——要改请去 [微软官网的皮肤与披风页面](https://www.minecraft.net/zh-hans/msaprofile/mygames/editskin)（启动器里点「去微软官网修改皮肤/披风」会按界面语言打开对应语言版本）；披风列表只显示你拥有的名字，仍可一键切换/移除
- **官方皮肤优先**：用正版账号启动时启动器不会再注入本地皮肤/披风，避免 CustomSkinLoader 那套把官方皮肤盖掉（离线账号不受影响）
- 第三方账号：只预览皮肤站上已装好的皮肤；自定义皮肤仅对离线账号开放
- 推荐素材站：皮肤 <https://littleskin.cn/> ｜ 披风 <https://mcstat.org/zh-Hans/skins/capes>

### 开服
- 内置服务端管理：从 **FastMirror**（<https://download.fastmirror.net>）按核心/版本/构建下载服务端，每台独立目录与配置
- 控制台实时输出（保留最近 2000 行）、`server.properties` 图形化编辑、一键启动/停止（停止失败会 `taskkill /T` 兜底）

### 背景与个性化
- **三种背景来源**：本地背景图（`NaiWa/backgrounds`）/ API 随机图 / Steam 壁纸引擎，各有独立开关、播放方式（单张/顺序/随机）与轮播间隔，另有一个总开关
- **每次启动随机一张**：三个来源各自可开启，启动时从该来源池子里随机取一张（与播放方式互不影响）
- **视频背景**：支持 mp4 / webm / ogv，可调音量（0 = 静音），与图片混合参与轮播
- **API 随机图**：默认关闭，自己填地址（可返回图片本身，或返回含图片地址的 JSON）；图片下载到 `NaiWa/cache/backgrounds` 并只保留最近 8 张
- **Steam 壁纸引擎**：自动探测 Steam 库并读取 `<Steam 库>\steamapps\workshop\content\431960`；**只识别视频与静态图两类壁纸**（`web` / `scene` 类型不列出——它们需要壁纸引擎自己的渲染器，列出来只会显示一张预览图误导人）；扫不到可在设置里手动指定目录
- 自绘标题栏（精简 / 图片）、界面图标可换 `NaiWa/icons`、整套换肤 + 自定义取色/渐变、透明度、背景音乐

### 联机（三种方式）
联机页有三种方式并存，按场景选：

| 方式 | 适合 | 说明 |
|---|---|---|
| **局域网直连** | 同一个局域网 | 直接填对方局域网地址；不需要额外组件 |
| **樱花穿透（natfrp）** | 长期开着的独立服务器 | 把本地 `25565` 通过公网 TCP 隧道暴露成固定地址，需要 Sakura FRP 令牌 |
| **陶瓦联机（Terracotta）** | 临时和朋友联机 / 分享专用服务器 | P2P + 邀请码；房主可以直接分享游戏里的局域网世界，也可以选「分享专用服务器」（填端口，启动器代它广播，房主不用开客户端） |

**三种方式都会提示联机模组**：离线玩家要进入别人的房间，**服主必须装一个能跳过正版验证的联机模组**。启动器会按实例的加载器推荐对应模组：

| 实例加载器 | 推荐顺序（逐个看有没有匹配当前版本的文件） |
|---|---|
| Fabric / Quilt | **OfflineLAN**（`offlinelan`） → **LAN World Plug-n-Play**（`mcwifipnp`） → LAN Properties（`lan-properties`） → LAN Server Properties（`lan-server-properties`） |
| Forge / NeoForge / Legacy Fabric | **LAN World Plug-n-Play**（`mcwifipnp`） → LAN Properties（`lan-properties`） → LAN Server Properties（`lan-server-properties`） |
| 原版 | —— **只能正版联机**：原版服务端会验证正版，离线账号进不来 |

> Fabric 只是**首选** OfflineLAN：它在当前 MC 版本没有可用文件时会自动回退到 LAN Properties（再不行 LAN Server Properties），并在提示里写明回退原因（"没有可用文件" 与 "暂时查不到" 会分开说明）。只有候选人全部没有可用文件时，才会显示「当前版本/加载器没有可安装的联机模组」。

- 实例**由你在提示卡里手动选择**（默认当前实例），判定与一键安装都按所选实例走；
- 联机模组可以**自己选**：下拉默认是推荐项，也可以换成别的（OfflineLAN / LAN World Plug-n-Play / LAN Properties / LAN Server Properties），旁边就是「立即安装」；选了不适配当前版本/加载器的会明确提示「装了也不会生效」但仍允许安装；选择按实例记住，旧选择失效会自动回落推荐；
- **始终显示是否已安装**：未选择实例 / 未安装 / 已安装（带版本）/ 已安装但版本不匹配；一键安装后立即刷新；
- **已装的是别的联机模组可以直接换装**：状态行写「已安装 OfflineLAN v2.0.0，但推荐 LAN World Plug-n-Play」，并给「卸载 OfflineLAN」；卸完立刻变成「一键安装 推荐项」；
- **同时装了多个**会全部列出（最多 4 条）并提示互相冲突（重复开端口、服务端可能起不来），建议只留一个；
- 该模组在当前版本或加载器下没有可用文件时如实说明，不给必然失败的安装按钮；
- 房客侧文案是「让房主安装/确认」。

陶瓦联机的实现要点：

- 首次使用会**按需下载官方程序**（约 9.4MB，GitHub 优先、Gitee 镜像兜底，带 sha256 校验），放在 `NaiWa/tools/terracotta`
- 启动器只通过它的**本地 HTTP API**（`127.0.0.1` 随机端口）创建/加入房间，端口不暴露给渲染进程
- 界面有常驻版权标注：联机能力由 **Terracotta | 陶瓦联机** 提供 · 版权所有 © burningtnt 及贡献者 · AGPL-3.0-or-later · [项目主页](https://github.com/burningtnt/Terracotta)（依据其许可证的例外条款：原样分发未修改的二进制 + 只经 IPC 交互 + 界面标注版权）
- 若你**自己已经开着一个陶瓦**，启动器会识别并复用它的端口（界面会提示「已复用正在运行的陶瓦」），「断开复用」只断开连接、不会结束你那个实例
- 详细技术资料（接口、状态机、实测数据、风险）见 [docs/TERRACOTTA-FEASIBILITY.md](docs/TERRACOTTA-FEASIBILITY.md)

### 启动失败诊断
- 游戏异常退出后自动读这次启动日志并给出结论，把 `# 诊断：` / `# 建议：` 写进日志，同时**弹窗**说明原因：
  | 能识别 | 典型症状 |
  |---|---|
  | 显卡驱动崩溃 | 崩溃帧里出现 `atio6axx.dll` / `nvoglv64.dll` / `ig*icd64.dll` 等驱动模块 |
  | Java 不信任证书 | `PKIX path building failed`（常见于 Steamcommunity302 之类的 HTTPS 代理） |
  | Java 版本不对 | `UnsupportedClassVersionError` |
  | 内存不足 | `OutOfMemoryError: Java heap space` |
  | JVM 参数导致起不来 | `Could not create the Java virtual machine` |
  | 模组冲突 / 缺前置 | `Mod resolution failed`、`Missing or unsupported mandatory dependencies`、`Duplicate mods found` 等 |
- 弹窗会列出**可能相关的模组**（去重、最多 8 个，含 jar 文件名），并提供 **打开日志 / 打开实例目录 / 导出诊断包**。
- **导出诊断包**：打包本次启动日志、`hs_err_pid*.log`、最新 crash-report、最近一份启动器日志，外加 `diagnosis.txt`（版本、实例与加载器、使用的 Java 与版本、退出码、诊断结论、相关模组），可直接发给别人排查。
- 日志按 UTF-8 / GBK 双解码，中文日志不会因编码漏判。

### 系统集成
- **单实例**：启动器只能开一个，再次双击会把已有窗口叫到前台并提示
- **托盘常驻**：右下角图标始终显示，随时点回界面；「关闭窗口时」可设为 询问我（首次）/ 隐藏到托盘 / 直接退出
- 启动 logo 淡入 → 渐变消失；**启动速度优化**（启动画面在第一个 await 之前创建、便携版解压一次后复用、语言包只保留中英、react 移出随包）
- **更新方式可选**，两种都会在启动后自动检测（延迟几秒，不阻塞启动）：
  - **手动（默认）**：检测到新版本会提示，你点「立即更新」才下载安装；
  - **自动**：检测到就自动下载并安装，装好自动重启；若游戏正在运行会等游戏结束再装
- **下载提示**：**开始下载**、完成、失败都会在右上角浮出提示，停留约 3.5 秒自动淡出；提示里带「查看」按钮，一点就跳到「管理」页；同一时间最多一条，500ms 内的多个任务会合并成「开始下载 N 个文件」（装整合包不会刷屏），有失败时优先显示失败
- **三语界面**：简体中文 / English / 日本語，设置里切换**立即生效**；主进程的报错与任务文案、数字与时间格式也会跟随语言
- **游戏语言跟随启动器**：切换语言后启动游戏，会按当前语言写 `options.txt`（中文→`zh_cn`、English→`en_us`、日本語→`ja_jp`），只改 `lang:` 一行、其余设置与换行风格原样保留；设置里的「强制游戏用中文」默认关闭，打开后一律简体中文
- **本地目录**（设置页）：一键打开启动器目录 / 游戏目录

> 关于页分两块卡片网格：**核心团队**（奶龙 / 小七 / DeepSeek，奶龙与小七指向源码仓库）与**链接与致谢**（项目主页、问题反馈、QQ 群、Modrinth、CurseForge、MCIM/BMCLAPI、麦块社区、MC 百科（MCMOD）、MCBBS、Steamcommunity 302、樱花穿透、陶瓦联机、Minecraft 官网，共 13 项），全部可点击、可键盘聚焦，各用对应官方标志。

## 截图

| 实例 | 模组商店 | 实例详情（模组管理 / 加载器切换） |
|---|---|---|
| ![](docs/images/instances.png) | ![](docs/images/mods.png) | ![](docs/images/instance-detail.png) |

| 账号 | 个性化 | 启动选项 | 其它设置 |
|---|---|---|---|
| ![](docs/images/accounts.png) | ![](docs/images/personalize.png) | ![](docs/images/launch-settings.png) | ![](docs/images/other-settings.png) |

## 安装

### 安装版（推荐，支持自动更新）
1. 运行 `NaiWaLauncher-Setup.exe`（固定名，永远指向最新版；也可用带版本号的 `NaiWaLauncher-Setup-<version>.exe`）
2. 默认安装到 **`C:\Program Files\naiwa`**，可改成任意目录
3. 安装完成后**根目录会有一个 `NaiWa Launcher.lnk` 快捷方式**，桌面与开始菜单也会创建快捷方式

安装后的目录（程序与数据分开，数据都在根目录）：

```
<安装目录>\
  NaiWa Launcher.lnk       快捷方式（指向 main\NaiWa Launcher.exe）
  Uninstall.exe
  main\                    程序本体：NaiWa Launcher.exe + resources / locales / *.dll …
  .minecraft\              游戏数据：versions / libraries / assets / instances
  NaiWa\                   启动器数据：config / logs / meta / downloads / java / backgrounds / music / skins / capes
  servers\  skins\  capes\  服务端、用户皮肤、用户披风
```

> 因为数据与程序同级，而 `Program Files` 默认只读，安装器会给安装目录加「Users 可修改」权限（`icacls`）。
> 升级安装会先结束正在运行的旧版进程，再清理旧版平铺布局留下的程序文件；**卸载只删除 `main\` 与快捷方式，玩家数据一律保留**。

### 免安装版
- `NaiWaLauncher-<version>-portable-x64.zip`：解压到任意可写目录，双击其中的启动器即可用（无需管理员权限），把整个文件夹拷走即可带走数据
- `NaiWaLauncher-<version>-single-exe.exe`（与 Release 里的 `NaiWaLauncher.exe` 相同）：单文件自解压版。**首次启动需要解压**（约 280 MB 到 `%TEMP%\NaiWaLauncher`），之后复用解压缓存，只有版本变化才会重新解压

### 自动更新
- **安装版**：点「立即更新」会下载 Release 里的 `NaiWaLauncher-Setup.exe`，静默安装回**当前所在目录**，然后自动重启（数据原地不动）
- 检查更新会依次尝试 GitHub 官方 API 与**七个加速节点**（能代理 API 的优先，其余也会试；并记住哪些可用）；若某个通道只给出版本号、拿不到发布资产清单，会用**固定名直链**（`releases/latest/download/NaiWaLauncher-Setup.exe`）兜底，不会因为读不到清单就不能更新
- **免安装版**：下载新的 `NaiWaLauncher.exe` 替换自身后重启

## 账号

| 类型 | 说明 |
|---|---|
| 离线账号 | 输入 3–16 位字母/数字/下划线即可玩单人游戏与离线服；可用本地或内置皮肤/披风 |
| 微软正版 | 设备码登录。**需要自备 Azure 应用 client id**（重定向类型选「公共客户端」，API 权限勾选 `XboxLive.signin`），填在「账号 → 微软账号」里 |
| 第三方（Yggdrasil） | 填 API 根地址（如 `https://littleskin.cn/api/yggdrasil`）登录，启动时注入 authlib-injector |

> 项目不内置 CurseForge Key。
>
> **关于微软登录**：内置公共 client id 为 `fd3e219a-6e6a-4188-8a39-e241f0e63324`（可在「账号」页替换：**留空即用内置，填了就完全不再使用内置**）。设备码 → XBL → XSTS 三段实测通过；Minecraft 服务端会校验 Azure 应用是否通过 **AppID 审批**（[申请页](https://help.minecraft.net/hc/en-us/articles/16254801392141)），未审批的应用在 `login_with_xbox` 返回 `403 Invalid app registration`。审批通过后无需改代码。
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
| 模组 | api.modrinth.com / api.curseforge.com（可选 Key）/ api.cfwidget.com（无 Key 模式）/ 麦块社区 |
| Java | BellSoft Liberica（download.bell-sw.com，GitHub 兜底）/ Adoptium（api.adoptium.net，GitHub 兜底）/ 清华 TUNA（mirrors.tuna.tsinghua.edu.cn/Adoptium） |
| 服务端 | download.fastmirror.net API v3 |
| 皮肤站推荐 | littleskin.cn ｜ mcstat.org（披风） |

## 开发

```powershell
pnpm install
pnpm typecheck        # 主进程 + 渲染进程类型检查
pnpm build            # tsc 主进程 + vite 构建渲染进程
pnpm dev              # 渲染进程 http://localhost:5273
$env:NAIWA_DEV_URL="http://localhost:5273"; pnpm start   # 另开终端跑 Electron

node scripts/build-app.mjs           # 打包 --dir（产物 release/win-unpacked）
node scripts/build-installer.mjs     # 自研 NSIS 安装包（固定名 + 带版本号副本）
powershell -File scripts/build-zip.ps1   # 免安装 zip
node scripts/build-app.mjs --win portable --x64  # 单文件便携版
node scripts/export-source.mjs       # 导出 源代码/ 快照
```

技术栈：Electron 38 + React 19 + TypeScript(strict) + Vite 7；`asar: false`（应用为明文目录，不加壳不混淆）；主进程与渲染进程通过 `preload` 暴露的 `window.naiwa` 通信，契约集中在 `src/shared/{types,ipc}.ts`。架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，杀毒误报说明见 [docs/AV-FALSE-POSITIVE.md](docs/AV-FALSE-POSITIVE.md)。

### 自己编译这份源码：需要你自己准备的两个凭据

这份源码里**没有内置任何凭据**（这是刻意的，避免把你的账号配置随源码一起发出去）。所以直接编译出来的版本会是「没内置 client id、没有内置 DeepL Key」的状态，表现为：

| 功能 | 没有凭据时的表现 | 怎么补 |
|---|---|---|
| 微软正版登录 | 设置 → 账号里 client id 为空，点登录会提示需要填写 | 自己申请一个 Azure 应用（公共客户端、允许设备代码流），把 id 填到设置页，或用下面的环境变量 |
| 模组/详情翻译 | 只走两个免费接口（uapis.cn / suapi.net），可用但可能被限流 | 填自己的 DeepL Key（设置 → 其它 → DeepL API Key），或按下面方式注入 |

两种注入方式（**编译/打包时**生效，二选一）：

1. **环境变量**（最简单）：`NAIWA_MS_CLIENT_ID` 与 `NAIWA_DEEPL_API_KEY`
   ```powershell
   $env:NAIWA_MS_CLIENT_ID="你的-azure-client-id"
   $env:NAIWA_DEEPL_API_KEY="你的-deepl-key:fx"
   node scripts/build-app.mjs
   ```
2. **本地文件**：在仓库根目录建 `.ms-client-id`（已被 `.gitignore` 忽略，也不会进 `源代码/` 快照），第一行放 client id，第二行放 `DEEPL_KEY=...`；`scripts/build-app.mjs` 会在 `tsc` 之后把这两个值注入到编译产物里。

> 注意：编译产物 `dist-electron/main/core/settings.js` 里是占位符，**每次重新编译都要经过 `build-app.mjs` 才会注入**；直接 `tsc` 出来的产物里凭据是空的。

### 用到网络/官方接口的功能：说明与注意事项

- **微软正版皮肤与披风**（皮肤页 → 微软正版皮肤）：靠 Mojang 官方接口读写，**必须先登录正版账号**。上传皮肤只接受 **64×64 或 64×32 的 PNG**，且皮肤需要账号已拥有 Java 版；换披风只能从**你账号已拥有**的披风里选，没拥有会导致 403（界面会给可读原因）。登录过期时会提示重新登录。
- **关于页的「最新新闻」**：从 Minecraft 官网抓最新一篇文章并机器翻译成中文。官网改版或网络/翻译服务不可用时，**这一块会自动不显示**（不会报错、不影响页面其它内容），下次进入会重试。
- **联机的联机模组推荐 / 服务端安装**：需要能访问 Modrinth 与麦块社区接口；接口不可用时会显示「查不到/未知」而不是给出错误结论。
- **从 GitHub 下载的一切**（游戏、Java、更新、GitHub 加速下载）：会按设置的加速节点依次尝试；全部失败才落原始地址，所以「全网都连不上 GitHub」时仍可能失败。

## 打包产物

| 文件 | 用途 |
|---|---|
| `NaiWaLauncher-Setup.exe` | 安装包（**固定名**，GitHub Release 与自动更新都认它） |
| `NaiWaLauncher-Setup-<version>.exe` | 同上，带版本号便于归档 |
| `NaiWaLauncher-<version>-single-exe.exe` | 单文件免安装版 |
| `NaiWaLauncher.exe` | 免安装版固定名（自动更新用，内容同上） |
| `NaiWaLauncher-<version>-portable-x64.zip` | 免安装压缩包 |

## 已知限制

- 仅 Windows x64；未做代码签名，首次运行可能有 SmartScreen 提示（见 [docs/AV-FALSE-POSITIVE.md](docs/AV-FALSE-POSITIVE.md)）
- 无 Key 模式的 CurseForge 只能按链接/ID 精确取项目，且没有哈希校验
- 微软账号需自行完成 AppID 审批才能登录正版服
- 切换「版本隔离」不会自动迁移已有模组目录
- 单文件便携版首次启动需要解压，比安装版慢；追求最快启动请用安装版或 zip
- 壁纸引擎只识别视频与静态图类型（scene / web 类型不渲染）；同目录内容需重启或点刷新才会重新扫描
- 三语覆盖界面与主进程文案，但**启动脚本正文、日志、代码注释**仍为中文；少数「前缀译文 + 后端原始响应」拼接的位置在英/日界面下会混排
- 模组名称、简介、日志等**数据**不做翻译
- 陶瓦联机依赖它的公共中继节点（实测出现过节点不可用，此时加入房间会报「连不上房主」）；节点列表目前是内置的，后续可做成可配置项
- 陶瓦每次运行会把约 21MB 的 EasyTier 组件释放到 `%TEMP%\terracotta`，启动器会在下次启动时清理超过 24 小时的历史目录
- 陶瓦「分享专用服务器」会在建房前检查本机端口：**没在监听时会先弹一次确认**（可以确认后继续，因为服务器可能还在启动），检查本身失败则不阻拦；若局域网广播被防火墙/网卡拦住，界面会红字提示
- 自动更新是「下载完、等你游戏退出后再装」：游戏一直开着就一直排队，退出启动器则放弃本次更新
- Java 的 Oracle JDK 源来自第三方镜像、受 Oracle 官方许可约束，因此**不参与自动测速**、只在手动选择时出现；该镜像无可用性保证，列表改版时该源会显示为空（不会崩）

## 许可

MIT，见 [LICENSE](LICENSE)。开发者：**奶龙**。

## 杀毒软件误报

本程序不加壳、不混淆（`asar: false`，应用文件为明文目录），exe 版本信息完整。若被杀软报毒，多半是行为特征触发（例如可选的托盘、可选的进程优先级脚本、第三方账号必需的 authlib-injector 注入）——**这些敏感行为默认关闭**，需要时可在设置里开启。
误报申诉所需的完整行为清单与提交入口见 [docs/AV-FALSE-POSITIVE.md](docs/AV-FALSE-POSITIVE.md)。单文件便携版是自解压结构，如有误报请优先用 `Setup` 安装版或 `portable-x64.zip`。
