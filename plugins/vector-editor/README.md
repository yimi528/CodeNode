# 矢量编辑器插件

CodeNode 随应用分发的可停用的第一方插件，默认启用。入口、版本与节点能力见 `plugin.json`，源码独立位于本目录；宿主通过 `configureHost` 注入图状态、界面状态和空格平移 Hook，插件不在运行时导入宿主业务模块。

在「设置 → 界面 → 矢量编辑器」启用或停用「矢量编辑器」。已有矢量节点在插件关闭时显示占位；启用后继续使用原绘图。启用后可用工作台工具栏或画布菜单新增矢量节点。

宿主在启用时动态加载插件入口和样式。插件提供节点组件、缩略图绘制和文档订阅；加载失败有重试入口。停用会卸载编辑界面、快捷键与缩略图订阅，已经加载的浏览器模块和 CSS 会保留至页面重载。

现有节点类型 `vector`、节点 ID、工程数据及 `codenode.vector.project.v2` 系列 localStorage 存储键保持兼容。停用插件不清理文档。绘图继续沿用原有本机存储方式；此次拆分没有新增跨机器携带绘图的保证。

默认构建包含可选插件文件。如需完全排除插件代码与样式：

```bash
VITE_VECTOR_EDITOR_PLUGIN=disabled npx vite build
```

此构建仍保留旧节点占位和数据，尝试启用时会说明插件未包含在当前构建中。此插件目前通过项目构建管线分发，不提供第三方插件下载、任意代码安装或独立安装包。

插件类型检查独立执行：`npx tsc -p plugins/vector-editor/tsconfig.json`。宿主只依赖轻量 API 契约，通过懒加载模块发现入口，核心 TypeScript 检查不遍历插件实现。

回归：`npm run test:optional-vector-ui`、`npm run test:workflow-canvas-ui`、`npm run test:vector`。
