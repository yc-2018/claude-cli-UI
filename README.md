# claude-cli-UI

![cli提问UI打开看](https://img11.360buyimg.com/cxxjwimg/jfs/t1/487648/20/4789/180082/6a65ec6cF6c27e7b3/06d7a4d863980fae.webp)



![](https://img11.360buyimg.com/cxxjwimg/jfs/t1/481591/6/10281/28664/6a66038bF6d494410/06d75272f925fe88.webp)![](https://img11.360buyimg.com/cxxjwimg/jfs/t1/484221/15/7928/59216/6a660360F89c26628/06d750f2eb9cd034.webp)

![](https://img11.360buyimg.com/cxxjwimg/jfs/t1/483156/28/9823/116302/6a6644f9F9c33340c/06d7a4d5f1d24254.webp)

claude-cli-UI 是一个运行在本机的 Claude CLI 桌面界面，使用 Electron、React 和 TypeScript 构建。

> [!IMPORTANT]
> 本项目是第三方开源客户端，与 Anthropic 及 Claude 官方无关，也未获得其认可、授权或赞助。

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

项目行右侧的刷新按钮会重新扫描 Claude CLI 会话，并载入 CLI 在应用外追加的消息，不需要关闭并重开应用。会话名称会与 Claude CLI 的自定义标题双向同步，列表同时显示最后更新时间和 Git 分支。将鼠标移到已完成的 Claude 回复上，可从该轮回答结束处创建独立会话分支；新分支会写入 Claude CLI 历史并使用递增编号命名。侧边栏右缘可拖动调整宽度。历史来自应用所在电脑的 Claude 配置目录（默认 `%USERPROFILE%\.claude\projects`，也支持 `CLAUDE_CONFIG_DIR`），Portable 版本应读取并对应同一台电脑上的 Claude CLI 历史。

运行中的会话会在侧边栏显示动态状态。其他会话完成后，应用会在右下角显示可点击提醒；窗口隐藏时使用 Windows notification，点击后会恢复窗口并跳转到对应会话。侧边栏底部的设置可以选择关闭窗口时退出应用或继续在 tray 后台运行，默认使用 tray；也可以关闭后台会话完成提醒。选择退出应用且仍有会话运行时，会提供“后台继续”“停止并退出”“取消”三个选项。

应用会自动检查 [GitHub Releases](https://github.com/yc-2018/claude-cli-UI/releases)，也可以在设置中手动检查。Portable 版会下载新版、校验 SHA-256，启动新版后将旧文件移入 Windows 回收站；Setup 安装版会下载更新并在确认后重启安装。更新过程中不会上传项目、对话或 Claude 凭据。

从 Portable `v0.1.25` 或 `v0.1.26` 升级时，需要从 Releases 手动下载 `v0.1.27` 一次。这两个旧版本未处理 GitHub 对带空格资产名的规范化；从 `v0.1.27` 开始，后续版本可以继续使用应用内自动更新。

从 claude-cli-UI 删除带 CLI session 的对话时，对应的 Claude CLI 会话文件会移入 Windows 回收站，并从 CLI 的 `/resume` 中消失。

模型下拉框动态读取全局及项目 `.claude/settings*.json` 中的模型配置，并分别显示 Sonnet、Opus、Fable 和 Haiku 角色及其实际映射名称。即使多个角色映射到同一个模型，它们也仍是独立选项。

输入 `/` 会打开命令菜单。本地支持 `/model`、`/new`、`/project`、`/clear`、`/plan` 和 `/edit`；Claude CLI 初始化后返回的技能与命令也会加入补全列表。

## 验证

```powershell
npm test
```

验证包含类型检查、旧数据迁移、项目与多对话、动态第三方模型、斜杠命令、高频流输出、异常退出、主动停止、重启持久化和桌面布局截图。





## 友情链接

- [linux.do](https://linux.do)

## License

This project is MIT — see [LICENSE](LICENSE).
