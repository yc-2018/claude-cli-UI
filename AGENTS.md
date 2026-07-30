# claude-cli-UI 仓库指南

## 产品范围

claude-cli-UI 是一个 Windows 优先的 Electron 桌面界面，用于调用本机已安装的 Claude CLI。它将工作目录组织为项目，每个项目支持多个对话，并且能够发现和恢复 Claude CLI 已有的 session。应用必须保持 local-first：不要添加托管后端、收集 telemetry，也不要在本仓库中存储 Claude 凭据。

## 仓库结构

- `electron/main.ts`：Electron 生命周期、原生对话框与 shell 集成、Claude CLI 进程管理、模型发现以及 CLI session 解析。
- `electron/preload.ts`：暴露给 renderer 的精简 IPC bridge。
- `src/`：React renderer、UI 组件、共享类型和本地持久化逻辑。
- `tests/workflow.mjs`：使用 fake Claude CLI 执行的端到端行为测试。
- `tests/visual-smoke.mjs`：桌面窗口和紧凑窗口布局的视觉检查。
- `dist/`、`dist-electron/`、`release/` 和 `artifacts/`：生成产物，禁止手动编辑或提交这些目录。

## 开发命令

使用 Node.js 22 或更高版本，并根据 lockfile 安装依赖。

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run dist
```

`npm test` 是合并前必须执行的检查。它会运行类型检查、构建 Electron main process 和 renderer process、执行 workflow 测试，并执行 visual smoke 测试。

## 架构规则

- Node.js 和操作系统访问必须放在 Electron main process 中。renderer 必须通过 `electron/preload.ts` 暴露、并在 `src/global.d.ts` 中声明的 typed API 访问这些能力。
- 新增 IPC 时，必须同时更新 main handler、preload bridge、global declaration 以及共享的 request/response 类型。renderer 提供的路径和值必须在 main process 中验证。
- 将 `%USERPROFILE%\.claude\projects` 下的 session JSONL 文件视为 Claude 所有的数据。导入的历史记录必须保留原始 session ID。允许的修改只有：Claude 进程退出后，规范化 claude-cli-UI 写入的顶层 `entrypoint` 和 `promptSource` 字段；用户重命名后追加一条 `custom-title` 记录；根据用户选择的 transcript 前缀创建一个重新生成标识的新 session；以及将用户确认删除的 session 移入操作系统回收站。分叉操作不得修改源 session。禁止修改现有 session 中的消息内容、UUID 或 tool record。
- 不要把导入的消息正文持久化到 `localStorage`，只保存重新发现这些消息所需的 metadata。必须保留 storage migration，并兼容损坏或旧版本的保存数据。
- streaming event 必须始终与对应的 run ID 关联。被停止或失败的进程必须让对话保持可用状态，并且不得泄漏 listener 或 child process。
- 保持现有的 model-role mapping 行为。Sonnet、Opus、Fable 和 Haiku 等模型角色可能映射到同一个实际模型，但在 UI 中仍必须保留为不同选项。

## UI 要求

- 一个项目代表一个真实的 workspace 目录，并且可以包含多个对话。
- 项目别名和对话标题必须保持可编辑。项目别名与真实目录名不同时，两者都要显示。
- 已有 Claude CLI session、thinking block、tool activity、permission mode 和模型信息必须保持可见，并且能够恢复。
- 发送消息后，除非用户主动向上滚动并离开底部，否则应持续显示最新输出。
- 保持现有克制的桌面工具设计。复用 Lucide icon、现有组件、间距、颜色和交互模式，不要引入第二套视觉语言。
- 在桌面窗口和紧凑窗口尺寸下，都要确认控件和文字不会重叠。

## 代码和测试约定

- TypeScript 使用 strict 模式。优先使用明确的 domain type，不要使用 `any`，renderer state 更新必须保持 immutable。
- 遵循现有格式：两个空格缩进、双引号、分号以及小而聚焦的函数。
- 修改范围必须限定在用户请求的行为内。不要重写无关代码或生成文件。
- 行为变更需要更新 `tests/workflow.mjs`，布局或交互变更需要更新 `tests/visual-smoke.mjs`。修复 bug 时要添加 regression assertion。
- 测试不得依赖开发者真实的 Claude 登录状态，也不得修改真实的 Claude 历史记录。

## 发布

GitHub Actions workflow 会在 push 和 pull request 时运行完整测试，只有推送 `v*` tag 时才构建 Windows 产物并发布 GitHub Release。**每次打包都必须使用新版本号**：先升级 `package.json` 和 `package-lock.json` 中的版本（至少 patch），再构建产物；禁止用相同版本号重复打包、覆盖 `release/` 中已存在的同名产物。发布新版本时，先更新 `package.json` 和 `package-lock.json` 中的版本号并提交，然后推送匹配的 tag，例如 `v0.2.0`。tag 必须与 package version 完全一致。
