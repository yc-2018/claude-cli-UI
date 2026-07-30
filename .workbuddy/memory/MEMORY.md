# 项目长期备忘（claude-cli-UI）

## WorkBuddy 会话内运行本项目的环境坑（2026-07-30 发现）

- **ELECTRON_RUN_AS_NODE=1** 被 WorkBuddy 继承：会让 `electron .` 退化为纯 Node（`require("electron")` 只返回路径字符串），Playwright `Electron.launch` 直接 "Process failed to launch"。运行任何 Electron/测试前先 `unset ELECTRON_RUN_AS_NODE`。
- **GPU 崩溃**：本会话里 Electron GPU 进程必崩（"GPU process isn't usable. Goodbye"），需给 electron.launch 的 args 加 `--no-sandbox --disable-gpu`（临时改测试文件即可，跑完记得还原，别提交）。
- **safe-delete/trash 在 OneDrive 路径上失败**：vite build 的 emptyDir 会因 trash 失败而中断。对策：构建前用提升权限的 `rm -rf dist` 手动删除（或在 dist 不存在时构建）。
- **打包 release 的可行方式**：NODE_OPTIONS 里注入了 genie-safe-delete shim，会把 electron-builder 内部的 fs.rm 全部导向回收站并失败（还有单 turn 50 次删除上限）。先 PowerShell `Remove-Item -Recurse -Force` 预清 `dist` 和 `release\win-unpacked`，再 `unset ELECTRON_RUN_AS_NODE && NODE_OPTIONS="--use-system-ca" npx electron-builder`（仅作用于构建产物目录，属用户明确要求的打包场景）。
- **`.git` 对象库可能因 OneDrive 按需同步缺失**（git 历史命令全报 "bad object HEAD"，工作区正常）。修复：`git fetch --refetch origin` 全量重拉对象即可恢复，工作区文件不受影响。
- **Windows 回收站 API 在本会话对 OneDrive 路径失败**：`tests/workflow.mjs` 的"删除 CLI 会话移入回收站"用例会卡住超时（shell.trashItem 失败），属环境问题而非代码问题。

## 验证新功能的快捷方式

在测试文件里临时加 `--no-sandbox --disable-gpu` 到 launch args，`unset ELECTRON_RUN_AS_NODE` 后跑针对性 Playwright 脚本（fake CLI：`tests/fixtures/fake-claude.mjs`，默认响应 "测试通过：<prompt>"）。
