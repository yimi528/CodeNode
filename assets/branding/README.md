# CodeNode 应用图标

`codenode-icon.png` 是正式应用图标的唯一源文件。2026-11-17 起使用用户提供的 `icon_画板 122.png`，保留原图及透明背景；后续开发和发布继续使用此图，不自动替换或重新设计。

更新源文件后运行 `npm run icons:build -- --force`，同步生成 `build/icon-*.png`、Windows `build/icon.ico` 及源文件指纹。macOS 打包使用 `build/icon-1024.png` 生成 ICNS，Linux 使用 `build/icon-512.png`。各平台路径已在 `package.json` 中配置。
