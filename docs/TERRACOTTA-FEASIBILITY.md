# 陶瓦联机（Terracotta）内嵌可行性研究

> 结论：**有条件可行**。技术路径已真机跑通到 `host-ok`（拿到真实邀请码、EasyTier 被拉起），无需管理员权限；但有三项条件与若干风险，暂未接入功能，先归档结论与复跑脚本。
>
> 研究对象：`D:\minecraft\Terracotta-master`（Rust，v0.4.2 源码）；试验产物在 `.scratch/tera-test/`（**未入库**，含 9.4MB exe）。**研究期间未修改该项目任何文件。**

## 1. 接入方式（官方文档 + 实测一致）

Terracotta 内嵌一个 HTTP 服务，只监听 `127.0.0.1`、端口随机、无鉴权、**无 CORS**（必须由启动器主进程请求）。集成模式：

```
terracotta.exe --hmcl <file>
  → 就绪后把 {"port": N} 写入 <file>（先 .tmp 再改名）
  → 之后轮询 GET /state（建议 500ms）
```

### 接口

| Endpoint | 参数 | 说明 |
|---|---|---|
| `GET /meta` | — | `version`（实测 `0.4.2`，文档写 `v0.4.2`）、`easytier_version`、`compile_timestamp`、`yggdrasil_port`、`target_*` |
| `GET /state` | — | 状态机 JSON；`index` 单调递增且会跳号，需按最大 index 去重 |
| `GET /state/ide` | — | 复位为 `waiting`；**`exception` 之后唯一出口** |
| `GET /state/scanning` | `room?` `player?` `public_nodes*` | 房主开始扫描本机 Minecraft 局域网端口（仅 `waiting` 生效） |
| `GET /state/guesting` | `room`（必填）`player?` `public_nodes*` | 加入房间；格式错或非 `waiting` → 400 |
| `GET /log?fetch=true` | — | 返回 `application.log` 全文 |
| `GET /panic?peaceful=true` | — | 立即退出；**连接被切断属正常**（curl 000 / ECONNRESET） |

### 状态机

```
waiting → host-scanning → host-starting{room} → host-ok{room, profiles[]}
       → guest-connecting → guest-starting{room, difficulty} → guest-ok{url, profiles[]}
       → exception{type 0-5}   // 0 连不上房主 / 1 与房主断连 / 2 房客 easytier 崩
                              // 3 房主 easytier 崩 / 4 房主服务器失联 / 5 脚手架协议错
```

邀请码格式 `U/XXXX-XXXX-XXXX-XXXX`：34 进制（无 `I`/`O`），`value % 7 == 0`；低 8 字符为 `network_name`（前缀 `scaffolding-mc-`），高 8 字符为 `network_secret`。解析宽松（大小写不敏感、`I→1`/`O→0`、可嵌在长文本里）。

## 2. 实测证据（Windows 10/11 x64，普通用户，无提权）

- 二进制：GitHub Releases `v0.4.2`，`pkg.tar.gz` 8,135,914 B（sha256 `07EBE139…0745F0`）→ 解包 `terracotta.exe` 9,402,880 B（sha256 `74C10568…449796`）+ `VCRUNTIME140.DLL`
- 冷启动：**135 ms** 出端口文件 `{ "port": 13975 }`，再过 **53 ms** `/meta` 可用
- 第二次启动：**154 ms**，日志 `Successfully join the global mutex, port = 13975` / `Running in secondary mode`，自身退出（复用端口）
- 优雅退出后（锁文件残留旧端口）再冷启动：拿到**新端口 9208**（无人持锁时陈旧锁文件被无视）
- `/state`：`{"index":0,"state":"waiting"}` → 假局域网广播后 **约 1 秒**直接到 `{"index":3,"state":"host-ok","room":"U/UX7Y-9M3E-X099-GMLW"}`，`easytier-core.exe` 被拉起
- 对已关闭房间 `guesting`：16 秒后 `{"state":"exception","type":0}`
- **不需要管理员权限**：`is_elevated=False` 全程跑通；exe manifest 无 `requestedExecutionLevel`；EasyTier 以 `--no-tun` 启动（不建虚拟网卡、不装驱动），无 UAC、无防火墙规则
- `--hmcl` 的 bootstrap 进程会立刻退出，真正干活的是被遗留的 worker → **`child.kill()` 杀不掉**，必须按端口反查 PID

## 3. 内嵌方案（未实施，供后续决策）

1. **二进制分发**：按需下载到工具目录（复用 `src/main/net/natfrp.ts` 里 frpc 的「版本 + 体积 + 哈希」模式），不要塞 `resources/`（9.4MB exe 会白涨安装包体积）。校验 sha256，并用 `/meta` 的 `version`/`easytier_version` 二次比对。`VCRUNTIME140.DLL` 需一起落地（缺它的机器会启动失败）。
2. **启动与收尾**：spawn 前**先删端口文件**（旧的 `{"port":N}` 会被瞬间读到，连到死端口）；端口文件出现后再重试 `/meta` 直到 200；500ms 轮询 `/state`；退出用 `GET /panic?peaceful=true`（连接被 reset 视为成功）→ 等 2s → 端口反查 PID 兜底 `taskkill`。
3. **UI**：`NetPage.tsx` 增加第三个页签 + `NetTeraTab.tsx`；控件对应：创建房间 / 加入房间（输入框自动补 `U/` 与短横线）/ 邀请码卡片（等宽大字 + 复制）/ 成员列表（`profiles` 的 `name`/`kind`）/ 状态条（含 `difficulty`）/ `exception` 的人话错误 + 返回（`/state/ide`）/ 停止陶瓦 / 查看日志 / 版权条。
4. **IPC**：`net:tera*` 系列，全部在主进程请求（无 CORS）；**不要把端口暴露给渲染进程**（本地任意进程可调 `/state/ide`、`/panic`）。

## 4. 合规

项目为 AGPL-3.0-or-later，但许可证**例外条款**明确允许（原文见其 `README.md`）：

> 1. 你的程序通过打包的方式包含本作品未经修改的二进制形式，而没有静态或动态地链接到本作品；或
> 2. 你的程序通过本作品提供的进程间通信接口（如 HTTP API）与未经修改的本作品应用程序进行交互，且在您的程序用户界面明显处标识了本作品的版权信息。

因此接入时必须：**原样分发未修改的官方二进制 + 只通过 HTTP API 交互 + 在联机页显著位置标注**（建议文案）：

> 联机能力由 **Terracotta | 陶瓦联机** 提供 · 版权所有 © burningtnt 及贡献者 · AGPL-3.0-or-later · 项目主页 [github.com/burningtnt/Terracotta](https://github.com/burningtnt/Terracotta)

同时**不要**：修改 exe、静态/动态链接其 `cdylib`（`ffi/`）、把它的 Web UI 伪装成自家界面。

## 5. 风险清单（按现实影响排序）

1. **公共节点可用性（最大风险）**：实测房客侧 DNS 与重定向失败（`public2.easytier.cn` 无 A 记录、`etnode.zkitefly.eu.org` 跳转失败），16 秒后 `exception(0)`。默认节点硬编码 4 个（`tcp://public.easytier.top:11010`、`tcp://public2.easytier.cn:54321` + 两个 `etnode.zkitefly.eu.org`）。接入时**必须把节点做成可配置**。
2. **运行时自解压执行**：每次启动把 `easytier-core.exe`(16MB) / `easytier-cli.exe` / `Packet.dll` 释放到 `%TEMP%\terracotta\<时间>-<pid>\` 并执行，**退出不清理**（每次 +21MB）。对杀软是典型启发式命中行为，与「降低误报」方向冲突；需要文档说明 + 自家清理策略。
3. **全局单实例**：锁文件在 `%TEMP%\terracotta\terracotta.lock`，一台机器只能一个陶瓦。用户自己已开着时，我们的 spawn 会变成 secondary 复用它 → UI 必须识别并提示，否则会出现「我点创建房间，界面却是别人的房间」。
4. **本地端口无鉴权**：别把端口交给渲染进程，也别写到日志里。
5. **`host-ok` 只代表 EasyTier 起来了**，不代表端到端真的通；真实验证需要两台机器 + 真客户端。
6. **与「樱花穿透」的关系**：互补而非替代——natfrp 适合长期固定地址的独立服务器，陶瓦适合临时朋友联机（房主在游戏内「对局域网开放」即可）。两者同开会争端口/带宽。
7. **假服务器可绕过扫描**（研究用途）：`src/mc/scanning.rs` 只监听 UDP 4445 组播 `224.0.2.60`，只要 MOTD ≠ 陶瓦自身哨兵即采信；实测广播 `[MOTD]FakeMC Test[/MOTD][AD]25565[/AD]` 约 1 秒即到 `host-ok`。这意味着**「房主已开放局域网」这一步无法用假广播代替真实功能验证**。

## 6. 复跑脚本

`scripts/experiments/terracotta/probe.cjs`：给定官方 `terracotta.exe` 路径后，自动完成「启动 → 等端口 → `/meta` → `/state` → 广播假局域网 → 到 `host-ok` → 打印房间号 → `/state/ide` → `/panic` 收尾」，并清理端口文件。用法：

```powershell
node scripts/experiments/terracotta/probe.cjs "D:\path\to\terracotta.exe"
```

> 该脚本只做验证，不含任何产品代码；二进制不入库。
