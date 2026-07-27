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

项目行右侧的刷新按钮会重新扫描 Claude CLI 会话，并载入 CLI 在应用外追加的消息，不需要关闭并重开应用。会话名称会与 Claude CLI 的自定义标题双向同步，列表同时显示最后更新时间和 Git 分支。侧边栏右缘可拖动调整宽度。历史来自当前电脑的 Claude 配置目录（默认 `%USERPROFILE%\.claude\projects`，也支持 `CLAUDE_CONFIG_DIR`）；Portable 程序本身不携带、上传或跨电脑同步这些历史文件。

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
