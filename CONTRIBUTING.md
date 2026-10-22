# 贡献指南

感谢参与 NaiWa Launcher（奶娃启动器）。

## 开发环境

- Windows 10/11 x64
- Node.js 22+、pnpm 11+
- 首次：`pnpm install`

## 常用命令

```powershell
pnpm typecheck        # 主进程 + 渲染进程类型检查（提交前必须为 0 错误）
pnpm build            # 编译主进程 + 构建渲染进程
pnpm dev              # 渲染进程开发服务器 http://localhost:5273
$env:NAIWA_DEV_URL="http://localhost:5273"; pnpm start   # 另开终端跑 Electron
pnpm dist             # 打包：解包目录 + NSIS 安装包 + 免安装 ZIP
```

## 代码约定

- 主进程模块（core / minecraft / loaders / java / mods / auth）**不得 import electron**，保证可在纯 Node 下脚本化测试。
- 类型集中在 `src/shared/types.ts` 与 `src/shared/ipc.ts`，渲染进程只通过 `window.naiwa` 与主进程通信。
- 提交前请跑一次 `scripts` 下对应的自检脚本（如 `node scripts/translate-check.js`）。

## 提交 PR

1. Fork 并从 `main` 拉分支
2. 保持 `pnpm typecheck` 与 `pnpm build` 通过
3. 描述改动动机、验证方式（贴关键日志/截图）
