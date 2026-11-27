# CodeNode 已知问题与完成判据

本清单只记录尚未完成、且有明确证据与验收条件的问题。完成后保留条目并改为 `done`，同时链接对应开发日志或验证记录。

| ID | 优先级 | 状态 | 当前证据 | 完成判据 |
| --- | --- | --- | --- | --- |
| WIN-SANDBOX | P0 | blocked-external-platform | Windows Job Object 已覆盖外部 ACP/MSP 双向 stdio、进程树与资源限制，但能力快照仍诚实返回 `filesystemIsolation=false`。安全门禁已改为：只要没有真实文件系统隔离，外部 Agent 在 `best-effort`/`strict` 都拒绝启动；仅用户显式设置 `sandbox.mode=off` 才可跳过。 | 在真实 Windows CI/桌面上用 AppContainer、WSL2 隔离或等价内核边界运行外部 Agent；项目外写入被系统阻止，项目内 ACP 往返、取消与子进程清理通过，strict 不再因 filesystem 缺失拒绝。 |
| RELEASE-SIGNING | P0 | blocked-user-secret | Release workflow 已实现三平台打包、标签/main 校验、Windows fail-closed 签名和 SHA-256 清单；GitHub 当前没有签名 Secrets、标签或 Release。 | 配置 `CODENODE_WIN_CERT_PFX_BASE64`、`CODENODE_WIN_CERT_PASSWORD`（可选时间戳变量），创建与 `package.json` 一致的标签；Release workflow 全绿且 GitHub Release 含已签 Windows 制品和 `SHA256SUMS.txt`。 |
| BACKEND-MATRIX | P1 | in-progress | 已加入命令可用性、当前配置握手诊断与版本/平台限定的历史任务验证展示。Hermes 0.18.2 的已有记录仅覆盖连接、只读及单文件修改/独立测试；其余后端和取消/恢复等缺项仍需真实主机验证。 | 每个宣称支持的后端至少在一个真实主机完成连接、只读、文件任务、权限拒绝、取消/恢复；结果写入 `docs/validation/`，失败或未安装在 UI 中保持实验性/不可用状态。 |
| MODULE-SPLIT | P1 | in-progress | 本轮将提示词装配和超窗观测拆到独立模块，`agent.cjs` 3910→3236 行，主入口上限下调至 3240；提示词 567 行、超窗 119 行均有独立边界限制，沿用专项行为回归。运行循环与 IPC 的后续领域拆分继续跟踪。 | `agent.cjs` 与 `styles.css` 不再承担多个独立领域；每个新模块有专项测试，核心/UI 全量门禁通过，迁移后的行数上限继续下调。 |
| RUNTIME-OPTIONAL-TOOLS | P1 | done | 2026-11-17 修复无工具运行直接访问 tools.context 的公共异常；PNG 测试加载器适配静态资源，路径安全改为检验共享策略的真实行为，精简重复回复提示使原 Token 门槛通过。上一轮七项专项与全量 200/200 核心回归通过。 | 已满足；见 [当日开发日志](development-log/2026-11-17.md)。未放宽 Token 上限或取消安全行为验证。 |
| DESKTOP-ACCEPTANCE | P1 | done | 普通对话可选择项目测试、配置程序/argv、输入指纹范围、必需产物和修改前反例。主进程验证并冻结契约，自研和外部运行共用独立验收；续跑保留原规则和反例证据。真实 renderer/preload/main 与离线脚本化模型、真实工具和文件验证通过。 | 已满足本轮桌面入口范围；见 [配置说明](terminal-and-acceptance.zh-CN.md#桌面对话配置) 与 [当日开发日志](development-log/2026-11-17.md)。不代表真实模型解题能力、全部外部 Agent 实机或 Goal 独立验收已验证。 |
| MAC-PIXEL-QA | P2 | done | 2026-10-19 完整显示套件取得有效棋盘格参照（标准差 127.5）；日间 13.37、夜间 12.8、无色玻璃 14.59，均满足 ≤20，且状态保留通过。 | 已满足；证据为同一轮 `npm run test:display` 的 `test:bright-theme-ui`，完整显示套件 31/31 通过。 |

## 更新要求

- 每次开发先检查本清单是否有对应 ID；状态变化必须同步当天开发日志。
- `blocked-*` 只表示需要当前工作区之外的系统、凭据或软件，不代表允许降低门禁。
- 不允许用“测试跳过”“没有发现错误”或静态字符串匹配关闭真实平台/真实模型问题。
