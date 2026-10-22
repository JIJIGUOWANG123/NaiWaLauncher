# NaiWa Launcher · 模块契约（实现者必读）

产品名：显示为 `NaiWa Launcher`，设置页显示「奶娃启动器 / NaiWa Launcher」，开发者「奶龙」。仅 Windows。

## 1. 目录布局（模仿 PCL2：exe + .minecraft + NaiWa）

```
<根目录>/
  NaiWa Launcher.exe                                    单文件便携程序（自解压运行）
  .minecraft/                                           标准 Minecraft 游戏目录
    versions/<versionId>/<versionId>.json + .jar        原版与加载器版本
    libraries/                                          依赖库（Maven 布局）
    assets/{indexes,objects,log_configs}/               资源文件
    instances/<instanceId>/                             每实例的游戏目录（mods/ options.txt saves/ logs/）
    launcher_profiles.json                              Forge/NeoForge 安装器前置文件
  NaiWa/                                                启动器自身数据
    config/settings.json    settings.json               设置
    logs/                                               启动器日志
    meta/                                               元数据缓存
    downloads/                                          下载缓存（.part 断点续传）
    java/<major>-<version>/                             Liberica JDK
```

`core/paths.ts` 导出对应字段：`root / gameRoot / dataRoot / versions / libraries / assets / assetIndexes / assetObjects / instances / java / meta / downloads / logs / config / settingsFile`。
旧的「全部平铺在根目录」布局会在 `initPaths` 时自动迁移到新位置（同盘 rename，幂等）。

## 2. 技术约束（硬性）

- Electron 38 + React 19 + TypeScript（strict）+ Vite 7。已装依赖：`adm-zip`、`react`、`react-dom`。**禁止新增任何 npm 依赖**（需要时在回报里提出，由调度者决定）。
- `src/main/core/*`、`src/main/minecraft/*`、`src/main/loaders/*`、`src/main/java/*`、`src/main/mods/*` **不得 import electron**（保持可在纯 Node 下测试）。仅 `src/main/main.ts`、`src/main/ipc/*`、`src/main/splash.ts` 可用 electron。
- 所有跨模块类型来自 `src/shared/types.ts` 与 `src/shared/ipc.ts`，不得复制粘贴定义。
- 网络一律走 `core/http.ts` 的 `fetchJson/fetchText/downloadFile/downloadMany`（自动支持镜像与多线程）；不要直接 `fetch` 下载大文件。
- 进度与日志一律走 `core/events.ts` 的 `createTask()` 与 `core/logger.ts`。
- 文件路径一律用 `core/paths.ts` 导出的路径，不要硬编码盘符。
- 代码注释用中文，简短，只解释“为什么”。

## 3. 模块归属（谁写哪些文件）

| 模块 | 负责人 | 文件 |
|---|---|---|
| 基础设施 | core | `src/main/core/{paths,logger,events,http,sources,settings}.ts` |
| 游戏本体/实例/启动 | minecraft | `src/main/minecraft/{manifest,install,instances,launch,args}.ts` |
| 加载器与 Java | loaders-java | `src/main/loaders/{index,fabric,forge,neoforge,installer-runner}.ts`、`src/main/java/{index,liberica,locate}.ts` |
| 模组 | mods | `src/main/mods/{index,provider,modrinth,curseforge,install}.ts` |
| 界面 | ui | `src/renderer/**`（除现有 `index.html`/`main.tsx` 可改） |
| 集成 | 调度者 | `src/main/main.ts`、`src/main/ipc/*`、`src/main/splash.ts`、`src/preload/*` |

**只允许修改自己名下的文件**，其他文件即使有 bug 也在回报里写出来。

## 4. 模块导出契约（签名不可改；桩已存在）

### core/paths.ts
```ts
export interface LauncherPaths { root, versions, libraries, assets, assetIndexes, assetObjects, java, instances, meta, downloads, logs, config, settingsFile: string }
export function initPaths(rootDir: string): LauncherPaths
export function getPaths(): LauncherPaths
export function ensureDirs(): Promise<void>
export function versionDir(versionId: string): string
export function instanceModsDir(instanceId: string): string
export function instanceDir(instanceId: string): string
```
根目录解析：打包后为 exe 所在目录；开发态为项目根（`app.isPackaged`/环境变量由集成层通过 `initPaths(root)` 注入）。

### core/logger.ts
```ts
export function setLogSink(sink: (l: LogLine) => void): void
export function logger(scope: string): { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
```

### core/events.ts
```ts
export interface TaskHandle { id: string; kind: TaskKind; label: string; update(p: Partial<TaskProgress>): void; done(data?: unknown): void; fail(err: unknown): void }
export function setEventSink(sink: { progress(p: TaskProgress): void; done(r: TaskResult): void }): void
export function createTask(kind: TaskKind, label: string): TaskHandle
```

### core/http.ts
```ts
export interface DownloadOptions { task?: TaskHandle; expectedSha1?: string; connections?: number; label?: string; headers?: Record<string, string> }
export function downloadFile(url: string, dest: string, opts?: DownloadOptions): Promise<{ bytes: number; reused: boolean }>
export function fetchJson<T>(url: string, opts?: { timeoutMs?: number; retries?: number; allowMirror?: boolean; headers?: Record<string, string> }): Promise<T>
export function fetchText(url: string, opts?: { timeoutMs?: number; retries?: number; allowMirror?: boolean; headers?: Record<string, string> }): Promise<string>
export function downloadMany(items: { url: string; dest: string; sha1?: string; size?: number }[], opts?: { task?: TaskHandle; concurrent?: number; connections?: number; label?: string }): Promise<{ failed: { url: string; dest: string; error: string }[] }>
```
要求：单文件多线程 Range 下载（并发连接数取设置）、断点续传、sha1 校验、失败重试（3 次）、404/403 快速失败；聚合进度到 TaskHandle。

### core/sources.ts
```ts
export const SOURCES: DownloadSourceInfo[]
export function mapUrl(officialUrl: string, source: DownloadSourceId): string
export function resolveBase(source: DownloadSourceId): DownloadSourceId  // auto → 实测更快者
export function probeSources(): Promise<SourceProbe[]>
export function setActiveSource(id: DownloadSourceId): void
export function getActiveSource(): DownloadSourceId
```
镜像映射规则（BMCLAPI）：`launchermeta/piston-meta/piston-data.minecraft? mojang host → https://bmclapi2.bangbang93.com`；`libraries.minecraft.net → /maven/`；`resources.download.minecraft.net → /assets/`。官方源保持原样。

### core/settings.ts
```ts
export function loadSettings(): Promise<Settings>
export function getSettings(): Settings  // 同步读取缓存，未加载时返回默认值
export function updateSettings(patch: Partial<Settings>): Promise<Settings>
export function defaults(): Settings
```

### minecraft/manifest.ts
```ts
export function listVersions(forceRefresh?: boolean): Promise<VersionBrief[]>
export function getVersionJson(versionId: string): Promise<any>       // 已合并 inheritsFrom
export function getVanillaJson(mcVersion: string): Promise<any>
```

### minecraft/install.ts
```ts
export function isVersionInstalled(versionId: string): Promise<boolean>
export function installVersion(mcVersion: string): Promise<{ versionId: string }>   // 客户端 jar + libraries(natives) + assets + log4j 配置
```

### minecraft/instances.ts
```ts
export function listInstances(): Promise<InstanceMeta[]>
export function getInstance(id: string): Promise<InstanceMeta | undefined>
export function createInstance(req: CreateInstanceRequest): Promise<InstanceMeta>  // 装原版 → 装加载器 → 建实例目录
export function updateInstance(id: string, patch: Partial<InstanceMeta>): Promise<InstanceMeta>
export function deleteInstance(id: string): Promise<void>
```

### minecraft/launch.ts
```ts
export function buildLaunchArgs(instance: InstanceMeta): Promise<{ exe: string; args: string[] }>
export function launchInstance(id: string): Promise<void>   // 离线身份，detach 启动，日志落 logs/
```

### loaders/index.ts
```ts
export function listLoaderVersions(mcVersion: string, loader: LoaderKind): Promise<LoaderVersionInfo[]>
export function installLoader(input: { mcVersion: string; loader: LoaderKind; loaderVersion?: string }): Promise<{ versionId: string; loaderVersion: string }>
```
- Fabric：`https://meta.fabricmc.net/v2/versions/loader/<mc>` + maven 下载（无需运行安装器）。
- Forge：`https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json` 选版本，安装器 `https://maven.minecraftforge.net/net/minecraftforge/forge/<mc>-<loader>/forge-<mc>-<loader>-installer.jar`，用 `installer-runner` 以 `--installClient` 方式装到根目录（或自解压 libraries + 写 version json）。
- NeoForge：直连 `maven.neoforged.net` **不可达**；用 BMCLAPI 镜像 `https://bmclapi2.bangbang93.com/maven/` 取 metadata 与安装器 jar。

### java/index.ts
```ts
export function listJavaReleases(): Promise<JavaRelease[]>
export function listInstalledJava(): Promise<InstalledJava[]>
export function installJava(major: number, version: string): Promise<InstalledJava>
export function resolveJavaFor(mcVersion: string): Promise<string>   // 返回 javaw.exe 路径，缺失且设置允许时自动下载
```
Java 源：BellSoft Liberica，`https://api.bell-sw.com/v1/liberica/releases?version-feature=<major>&os=windows&arch=x86&bitness=64&bundle-type=jdk&output=json`（`downloadUrl` 为 zip）。

### mods/index.ts
```ts
export function searchMods(req: ModSearchRequest): Promise<ModSearchResult[]>
export function listModFiles(req: ModFilesRequest): Promise<ModFileInfo[]>
export function installMod(req: ModInstallRequest): Promise<{ fileName: string; path: string }>
export function listInstalledMods(instanceId: string): Promise<{ fileName: string; sizeBytes: number }[]>
```
- Modrinth：`https://api.modrinth.com/v2`，需 `User-Agent: NaiWaLauncher/0.1 (naiwa)`。
- CurseForge：`https://api.curseforge.com/v1`，需 `x-api-key`，取自设置；无 key 时抛出可读错误，不崩溃。
- 文件排序优先级（五档，tier 越小越优先）：0 完全匹配（gameVersion === 实例版本且 loader 匹配）；1 同系列匹配（文件声明 `1.21` / `1.21.3` 等与实例 `1.21.4` 同 major.minor 且 loader 匹配）；2 仅 loader 匹配；3 仅版本匹配；4 都不匹配。同档按发布时间倒序。`exactMatch` 仅在 tier 0 置 true。
- 若最优档为空（服务端过滤后无文件）则抛「没有适用于 <mc> / <loader> 的文件」，不降级安装。

## 4.9 个性化契约（追加）

- `Settings` 新增：`theme: ThemeId`、`accentColor`、`uiOpacity(0.6–1)`、`showSplash`、`backgroundImage`、`backgroundMusic`、`musicVolume(0–1)`、`titleBar: "default" | "compact" | "image"`。
- 主题预设：dragon/lemon/grass/pineapple(默认)/oak/midnight/candy/pink/mystery/lucky/autumn/orange/red/geek/custom。
- 媒体目录：`<root>/NaiWa/backgrounds`、`<root>/NaiWa/music`（`api.media.list()` 返回文件名与绝对目录，`api.media.openDir(kind)` 打开）。
- 窗口：`api.window.minimize/toggleMaximize/close/isMaximized`；当 `titleBar !== "default"` 时主窗口为无边框，渲染进程自绘标题栏（拖拽区 `-webkit-app-region: drag`）。
- 渲染进程主题通过 CSS 变量 `--accent / --accent-2 / --accent-soft / --ui-opacity` 应用；`index.html` CSP 允许 `img-src file:` 与 `media-src file:` 以加载本地背景图/音乐。

## 5. 自检与回报

- 改完必须跑：`node "C:\Users\JIJIKING\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "C:\Users\JIJIKING\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" typecheck`（在 D:\minecraft 下），必须 0 错误（其他人未完成导致的错误请只在回报中指名，不要改他们的文件）。
- 关键网络路径必须真实调用一次验证（可在临时脚本里 require 编译产物或用 node --experimental-strip-types 跑），回报里贴出实际响应片段。
- 回报格式：完成项 / 改动文件列表 / 自检证据（typecheck 输出、真实接口响应）/ 未解决风险。
