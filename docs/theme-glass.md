# CodeNode 主题

在「设置 → 常规与界面 → 主题」中点击太阳选择日间，点击月亮选择夜间。切换时画布、节点、侧栏、对话和设置面板一起过渡。开启系统的减少动态效果后，主题立即切换。

首次启动默认使用夜间。选择保存在本机，旧的无色玻璃设置会迁移到日间。

主题色值由 `config/ui.themes.json` 提供。运行 `npm run build --ignore-scripts` 后，可用 `npm run test:bright-theme-ui` 验证主题切换和窗口不透明度。
