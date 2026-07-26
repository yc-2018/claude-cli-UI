# Claude Desk

Claude Desk 是一个运行在本机的 Claude CLI 桌面界面，使用 Electron、React 和 TypeScript 构建。

## 开发

```powershell
npm install
npm run dev
```

## 构建

```powershell
npm run build
npm run dist
```

应用直接调用系统中已安装并完成登录的 `claude` 命令。每个项目绑定一个工作目录，项目下可以建立多个互相独立的对话，每个对话使用自己的 Claude CLI session。

模型下拉框动态读取全局及项目 `.claude/settings*.json` 中的模型配置。选择“跟随 CLI”时不传模型参数；选择具体模型时使用 `--model`，不包含硬编码的官方模型列表。

输入 `/` 会打开命令菜单。本地支持 `/model`、`/new`、`/project`、`/clear`、`/plan` 和 `/edit`；Claude CLI 初始化后返回的技能与命令也会加入补全列表。

## 验证

```powershell
npm test
```

验证包含类型检查、旧数据迁移、项目与多对话、动态第三方模型、斜杠命令、高频流输出、异常退出、主动停止、重启持久化和桌面布局截图。
