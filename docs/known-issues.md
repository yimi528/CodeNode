# CodeNode 已知问题与完成判据

本清单只记录尚未完成、且有明确证据与验收条件的问题。完成后保留条目并改为 `done`，同时链接对应开发日志或验证记录。

| ID | 优先级 | 状态 | 当前证据 | 完成判据 |
| --- | --- | --- | --- | --- |
| WIN-SANDBOX | P0 | blocked-external-platform | Windows Job Object 已覆盖外部 ACP/MSP 双向 stdio、进程树与资源限制，但能力快照仍诚实返回 `filesystemIsolation=false`。 | 在真实 Windows CI/桌面上用 AppContainer、WSL2 隔离或等价内核边界运行外部 Agent；项目外写入被系统阻止，项目内 ACP 往返、取消与子进程清理通过，strict 不再因 filesystem 缺失拒绝。 |
| RELEASE-SIGNING | P0 | blocked-user-secret | Release workflow 已实现三平台打包、标签/main 校验、Windows fail-closed 签名和 SHA-256 清单；GitHub 当前没有签名 Secrets、标签或 Release。 | 配置 `CODENODE_WIN_CERT_PFX_BASE64`、`CODENODE_WIN_CERT_PASSWORD`（可选时间戳变量），创建与 `package.json` 一致的标签；Release workflow 全绿且 GitHub Release 含已签 Windows 制品和 `SHA256SUMS.txt`。 |
| BACKEND-MATRIX | P1 | in-progress | Hermes 0.18.2 已通过只读真实模型 smoke 与单文件修改/独立测试；其余外部后端在当前主机没有对应 CLI，只完成协议夹具测试。 | 每个宣称支持的后端至少在一个真实主机完成连接、只读、文件任务、权限拒绝、取消/恢复；结果写入 `docs/validation/`，失败或未安装在 UI 中保持实验性/不可用状态。 |
| MODULE-SPLIT | P1 | in-progress | `WorkbenchDock` 873→696 行，`agent.cjs` 4591→4265 行，`ipc/agent.cjs` 1910→1876 行，`styles.css` 5113→3893 行；门禁禁止重新增长。 | `agent.cjs` 与 `styles.css` 不再承担多个独立领域；每个新模块有专项测试，核心/UI 全量门禁通过，迁移后的行数上限继续下调。 |
| MAC-PIXEL-QA | P2 | done | 2026-10-19 完整显示套件取得有效棋盘格参照（标准差 127.5）；日间 13.37、夜间 12.8、无色玻璃 14.59，均满足 ≤20，且状态保留通过。 | 已满足；证据为同一轮 `npm run test:display` 的 `test:bright-theme-ui`，完整显示套件 31/31 通过。 |

## 更新要求

- 每次开发先检查本清单是否有对应 ID；状态变化必须同步当天开发日志。
- `blocked-*` 只表示需要当前工作区之外的系统、凭据或软件，不代表允许降低门禁。
- 不允许用“测试跳过”“没有发现错误”或静态字符串匹配关闭真实平台/真实模型问题。
