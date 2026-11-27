# CodeNode

[English](README.md) · [简体中文](README.zh-CN.md)

CodeNode 是一款在本地代码仓库中使用编程智能体的桌面工作台。你可以在对话里提问，查看智能体读取了哪些文件、调用了哪些工具，再把后续任务放到画布上安排。`.cnode` 工程文件保存工作区，源码仍在原来的目录中。

![项目画布旁的智能体对话面板](docs/screenshots/agent-chat.png)

## 从源码启动

在有桌面环境的电脑上安装 Node.js 22.12 或更高版本，然后运行以下命令。

```sh
git clone https://github.com/yimi528/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

命令会启动 Vite 并打开 Electron 窗口。在项目侧栏打开已有工程，或为现有源码目录新建工程。在对话面板选择模型并连接服务商。第一次可以试试：“找到应用入口，列出启动时会经过的文件。”

## 在项目中工作

| 你想做什么 | 从哪里开始 |
| --- | --- |
| 理解或修改代码 | 对话支持 Markdown 表格和代码块。你可以在对话中审核工具请求，随后查看文件变更。 |
| 把计划拆成任务 | 在工作流画布上排列节点、连接依赖。在目标总览中新建草稿、查看子任务，或处理需要你确认的事项。[画布与目标](docs/canvas-and-goals.zh-CN.md) |
| 继续中断的任务 | 打开运行记录，检查断点。恢复视图会区分已经写入的内容和仍需确认的操作。[运行恢复](docs/run-recovery.zh-CN.md) |
| 更换执行任务的智能体 | 使用内置后端，或通过 ACP 接入外部智能体。[后端配置](docs/backends.zh-CN.md) |

## 参与开发

`npm run build` 检查渲染进程的类型并构建界面，`npm run check:js` 检查 Electron 主进程和脚本。运行 `npm test` 执行核心回归，或用 `npm run test:list` 查找单项检查。

改动合入 `main`。工作分支按 `<性质>-YYYYMMDD-<内容>` 命名，例如 `feat-20261127-merge-desktop-workbench`。环境配置与验证流程见[贡献指南](CONTRIBUTING.zh-CN.md)，架构、评测与开发记录见[文档索引](docs/README.md)。

## 许可证

[Apache License 2.0](LICENSE)
