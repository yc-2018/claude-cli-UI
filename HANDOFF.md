# claude-cli-UI 开发交接

这份文档用于在新会话中快速恢复项目上下文。开始开发前，先完整阅读根目录的 `AGENTS.md`，再阅读本文，并执行 `git status --short` 确认用户已有修改。

## 当前基线

- 仓库：`git@github.com:yc-2018/claude-cli-UI.git`
- 主分支：`main`
- 当前版本：`0.1.16`
- 当前已发布基线：tag `v0.1.16`
- 产品名称必须统一写作 `claude-cli-UI`。
- 项目是第三方开源客户端，与 Anthropic 及 Claude 官方无关；README 已有明确声明。
- 当前工作区包含尚未提交的后台会话功能、中文 `AGENTS.md`、README 修订和本文。不要在新会话中覆盖这些修改。

## 核心架构

本项目没有使用 Claude SDK。实际调用链如下：

```text
React renderer
  -> electron/preload.ts 暴露的 typed IPC
  -> electron/main.ts
  -> 启动本机已安装并已登录的 Claude CLI
```

Claude 进程的主要参数是：

```text
claude -p --verbose --output-format stream-json --include-partial-messages
```

根据会话状态还会添加 `--resume`、`--name`、`--model`、`--permission-mode`、`--allowedTools`、`--input-format stream-json` 和 `--add-dir`。不要把 Node.js、文件系统、shell 或进程能力直接放进 renderer；新增能力必须同步修改 main handler、preload bridge、`src/global.d.ts` 和共享类型。

## 数据位置与同步边界

- Claude CLI 历史默认位于 `%USERPROFILE%\.claude\projects`，设置了 `CLAUDE_CONFIG_DIR` 时使用该目录。
- 项目列表同时保存在 Electron `userData/projects.json` 和 renderer `localStorage`。main process 的副本用于在 Chromium Local Storage 丢失后恢复项目。
- 附件暂存在 Electron `userData/attachments`。
- 老版本如果存在 `%APPDATA%\claude-desk`，应用会继续使用这个 legacy `userData` 目录，以保留旧数据。
- Portable EXE 应读取它所在电脑的 Claude 配置目录，并与同一台电脑上的 Claude CLI 历史对应。此前在另一台电脑测试 `0.1.9` 时，出现过 Portable UI 没有正确同步那台电脑本机 CLI 会话的问题；这不是跨电脑同步诉求，也不能简单归因于 Portable 不携带历史。
- 项目刷新按钮会重新扫描 Claude CLI JSONL，并载入 CLI 在应用外追加的消息。当前没有 filesystem watcher，因此外部 CLI 修改后需要手动刷新。
- 导入的 Claude 消息正文不能持久化到 `localStorage`，只保存重新发现 session 所需的 metadata。

## Claude session 数据规则

`%USERPROFILE%\.claude\projects` 下的 JSONL 属于 Claude。现有实现只允许以下修改：

- claude-cli-UI 创建的消息完成后，把新增记录顶层的 `entrypoint: "sdk-cli"` 和 `promptSource: "sdk"` 规范化为 CLI 可在 `/resume` 中发现的值。
- UI 重命名会话时，追加 `custom-title` 记录，实现 UI 和 CLI 标题同步。
- 用户从某轮已完成的 assistant 回复处分叉时，复制截至该轮的 transcript，生成新的 session ID 和 UUID，绝不修改源 session。
- 用户确认删除带 session 的会话时，把对应 JSONL 及 sidecar 移入 Windows 回收站，使其从 CLI `/resume` 消失。

除上述情况外，不得修改现有 session 的消息内容、UUID 或 tool record。测试必须使用 fake Claude CLI，不能触碰开发者真实历史。

## 已完成功能

- 项目绑定真实 workspace，一个项目包含多个对话。
- 项目别名和会话名称可编辑；项目别名后以灰字显示真实目录名。
- 点击顶部项目名或右键项目可在文件管理器中打开 workspace。
- 项目操作按钮仅在 hover 时显示，支持新建对话和刷新 CLI session。
- 自动发现并导入现有 Claude CLI session，可恢复消息、thinking block、tool activity、permission mode、模型、更新时间和 Git branch。
- 会话标题通过 Claude `custom-title` 双向同步。
- 删除带 session 的会话会真正删除 CLI 历史，具体方式是移入回收站。
- 已完成 assistant 回复下方提供 hover 后出现的分叉按钮。新会话名称使用 `原名称 (2)`、`原名称 (3)` 递增。
- 所有用户/AI 消息下方提供 hover 后出现的复制按钮，一键复制消息内容并显示「已复制」反馈。
- 最后一条用户消息下方提供「编辑并重新发送」：内联编辑后重发，UI 层替换最后一轮问答（原附件一并重发）。注意 CLI session JSONL 不可改写，旧一轮仍保留在 Claude 上下文中。
- 侧边栏可拖动调整宽度，并保存宽度。
- streaming event 按 run ID 隔离；支持停止、失败恢复、thinking 和 tool activity 渲染。
- 自动滚动只在用户位于底部时跟随；用户主动向上滚动后，streaming 不会抢走位置。
- 模型下拉框读取全局及项目 `.claude/settings*.json`，保留 Sonnet、Opus、Fable、Haiku 四个角色，即使它们映射到同一实际模型也不合并。
- 输入 `/` 会补全本地命令 `/model`、`/new`、`/project`、`/clear`、`/plan`、`/edit`，并合并 Claude CLI 返回的命令与 skills。
- 支持按钮选择、拖入和粘贴附件。图片 MIME 支持 PNG、JPEG、GIF、WebP；图片通过 `stream-json` 以 base64 image block 发给 CLI，其他文件通过暂存目录和 `--add-dir` 提供。
- 附件限制：一次最多 10 个，单个不超过 20 MB，总计不超过 40 MB。
- 运行中的会话在侧边栏显示旋转状态图标，项目折叠时也显示项目级运行状态。
- 非当前会话完成时显示右下角可点击 toast；窗口隐藏或最小化时使用 Windows notification，点击后恢复窗口并跳转到对应会话。
- 侧边栏底部包含设置：关闭窗口时使用 tray 后台或退出应用，以及是否提醒后台会话完成。默认是 tray 后台并开启提醒。
- “退出应用”模式下若仍有会话运行，关闭窗口会提供“后台继续”“停止并退出”“取消”三个选择。

## 下次优先注意

### 1. 新会话标题长度目前不完全一致

`src/App.tsx` 的 `makeClaudeSessionName()` 会取首次 prompt 的前 10 个 Unicode 字符传给 Claude CLI `--name`，符合此前“前 10 个字作为会话名称”的要求；但 UI 首次发送时仍使用 `shorten(..., 28)` 临时更新本地标题。

这可能导致 UI 在刷新前显示最多 28 个字符，而 CLI 标题只有 10 个字符。若继续处理标题问题，应让 UI 和 CLI 使用同一个标题生成函数，并补充 workflow regression assertion。

### 2. 外部 CLI 更新不是实时监听

当前设计依靠项目行的刷新按钮同步 CLI 外部写入。若要自动同步，应实现受控 watcher，并特别处理：写入中的 JSONL、重复事件、当前 active run、session 删除以及窗口关闭时清理 watcher。

### 3. 另一台电脑上的本地 CLI discovery 需要继续验证

用户此前在另一台电脑使用 `0.1.9` 时，发现 UI 与那台电脑本机相同版本的 Claude CLI 会话没有对应上。后续版本已经改进项目发现、session 解析、`CLAUDE_CONFIG_DIR` 支持以及 `/resume` 可见性规范化，但不要把原问题描述成“两台电脑之间不会自动同步”。

若问题在当前版本复现，优先检查：

- UI 进程实际读取的 `CLAUDE_CONFIG_DIR` 与该电脑 CLI 使用的目录是否一致。
- workspace 转换成 `.claude/projects/<project-key>` 时，是否与 Claude CLI 的真实目录名一致。
- session JSONL 内的 `cwd` 是否仍存在，大小写、盘符、网络盘或非 ASCII 路径是否影响匹配。
- `discoverClaudeWorkspaces()` 目前每个 session 目录只抽查前 5 个 JSONL，每个文件只读取前 128 KB；目标 workspace 可能因此漏检。
- 用户手动添加项目后，项目刷新能否发现对应 session，以区分 project discovery 与 session parsing 问题。

### 4. visual smoke 对 hover 动画较敏感

`tests/visual-smoke.mjs` 已通过先把鼠标移到 `.composer`、等待 action 淡出，再 hover assistant 回复并等待淡入的方式稳定测试。调整 message action 的 CSS、DOM 或 transition 时必须同步修改该测试，避免 GitHub Actions 偶发失败。

### 5. Electron 包体积属于正常现象

Portable EXE 约 90 MB 主要来自 Electron 内置的 Chromium、Node.js 和 Electron runtime，不是 React UI 代码本身。Electron 可打包 Windows、macOS 和 Linux 桌面应用，不用于 Android 原生打包。目前 workflow 只构建 Windows NSIS 和 Portable。

## 测试与发布

开发环境要求 Node.js 22 或更高版本，优先使用 lockfile 安装：

```powershell
npm ci
npm test
```

`npm test` 会依次执行 TypeScript typecheck、Electron/renderer build、`tests/workflow.mjs` 和 `tests/visual-smoke.mjs`。行为改动更新 workflow test，布局或 hover 改动更新 visual smoke test。

当前后台会话改动已经通过 `npm run typecheck` 和 `npm run build`。本机执行 Electron Playwright 时，Electron 43.2.0 的 GPU process 触发 Windows `0x80000003` native 异常并持续弹框，因此本轮没有完成 workflow/visual smoke。相关测试代码已经补充，但必须在 GitHub Actions 或修复本机 Electron runtime 后运行完整 `npm test`。

本地打包：

```powershell
npm run dist
```

**每次打包都必须使用新版本号**：打包前先升级 `package.json` 和 `package-lock.json` 中的版本（至少 patch），禁止用相同版本号重复打包、覆盖 `release/` 中已存在的同名产物。

GitHub workflow 位于 `.github/workflows/windows-release.yml`：

- push 和 pull request 会测试并构建 Windows 安装版与 Portable。
- 普通构建产物保留 14 天。
- 发布版本时，同时更新 `package.json` 和 `package-lock.json`，提交后推送完全匹配的 tag，例如 `v0.2.0`。
- tag 与 package version 不一致时 workflow 会直接失败。
- 用户会自行反馈 GitHub Actions 错误，不需要主动持续监控 workflow。

## 工作习惯

- UI 文案以中文为主，Electron、IPC、renderer、session JSONL、localStorage、run ID 等特殊术语保留英文。
- 保持当前克制的桌面工具设计，复用 Lucide icon 和现有组件，不引入新的视觉语言。
- 不要编辑或提交 `dist/`、`dist-electron/`、`release/`、`artifacts/`。
- 不要默认提交、push、升级版本或打包；用户明确要求后再执行。
- 每次代码修改完成后应运行与风险相称的测试；准备发布前必须运行完整 `npm test`。
- 当前 Git 可能提示无法读取 `C:\Users\cgl\.config\git\ignore`，该 warning 目前不影响仓库操作。
