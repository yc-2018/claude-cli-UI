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

模型下拉框动态读取全局及项目 `.claude/settings*.json` 中的模型配置。选择“跟随 CLI”时不传模型参数；选择具体模型时使用 `--model`，不包含硬编码的官方模型列表。

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
