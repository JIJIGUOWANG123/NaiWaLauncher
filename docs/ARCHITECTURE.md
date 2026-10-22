# 架构说明

## 进程与分层

```
Electron 主进程 (src/main)
├─ core/       基础设施：路径 / 日志 / 事件 / HTTP+多线程下载+限速 / 下载源 / 设置
├─ minecraft/  版本清单与合并、原版安装、实例存储、启动参数与进程拉起
├─ loaders/    Fabric / Forge / NeoForge 安装（含安装器执行器）
├─ java/       Liberica JDK 下载安装、本机 JDK 探测、按版本选 Java
├─ mods/       Modrinth / CurseForge 客户端、五档版本匹配、安装/更新/删除
└─ ipc/        统一 IPC 注册（渲染进程唯一入口）
preload (src/preload)  contextBridge 暴露 window.naiwa（类型来自 shared/ipc.ts）
渲染进程 (src/renderer) React 19 + Vite，页面不直接碰 Node
```

约束：`core / minecraft / loaders / java / mods` **不 import electron**，可在纯 Node 下被脚本直接驱动（`scripts/e2e.js` 就是这么跑真链路的）。

## 关键设计

### 存储布局（模仿 PCL2）
`<root>/.minecraft` 放游戏数据（versions/libraries/assets/instances），`<root>/NaiWa` 放启动器数据（config/logs/meta/downloads/java）。旧版平铺布局由 `core/paths.ts` 在 `ensureDirs()` 时自动迁移（同盘 rename、幂等、不覆盖用户数据）。

### 下载
- 单文件多连接 Range 分片并行、断点续传（`.part.json`）、sha1 校验、失败重试；
- < 2MB 走单连接（避免小文件多握手）；**探测成本为零**（一次 GET 同时拿长度与 Range 能力）；
- 镜像失败自动跨源回退一次（例如 BMCLAPI 缺对象时回官方源）；
- 全局令牌桶限速（所有连接共享一份预算），设置改动即时生效。

### 版本与加载器
版本 JSON 的 `inheritsFrom` 递归合并，去重键为 `group:artifact:classifier`（忽略 version，让加载器自带的新版本覆盖原版旧版本，同时保留 natives 变体）。这一步是 Fabric 能启动的前提：重复的 ASM 会被 Fabric 直接拒绝。

### 模组版本匹配（五档）
0 完全匹配（版本 + 加载器）→ 1 同系列（1.21.3 对 1.21.4）→ 2 仅加载器 → 3 仅版本 → 4 都不匹配；同档按发布时间倒序；`exactMatch` 仅 tier 0 为真。

### 界面与主题
渲染进程通过 CSS 变量 `--accent / --accent-2 / --accent-soft / --ui-opacity` 应用主题；15 套预设 + 自定义取色；背景图/音乐来自 `NaiWa/backgrounds`、`NaiWa/music`；标题栏可选系统默认/自绘精简/图片（自绘时主窗口无边框）。

## 数据源

| 用途 | 地址 |
|---|---|
| 官方版本清单 | launchermeta.mojang.com / piston-meta.mojang.com |
| 镜像 | bmclapi2.bangbang93.com（文档 bmclapidoc.bangbang93.com） |
| 模组 | api.modrinth.com / api.curseforge.com（需 API Key） |
| Java | BellSoft Liberica（download.bell-sw.com 优先，GitHub 兜底） |

## 自检脚本

- `scripts/e2e.js`：新建实例 → 生成启动参数 → 真启动并判定进主菜单
- `scripts/smoke.js`：加载真实主进程 + preload + 渲染产物，逐页导航抓渲染端报错
- `scripts/build-installer.mjs`：用 electron-builder 缓存的 makensis 生成单文件安装包
