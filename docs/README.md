# CodeNode 文档导航

使用说明与运行约定放在本目录；设计方案归入 `proposals/`，评审与问题分析归入 `assessments/`。了解项目与启动方式，先看 [项目介绍](../README.zh-CN.md)。

## 使用与开发

| 文档 | 内容 |
| --- | --- |
| [画布与目标](canvas-and-goals.zh-CN.md) | 工作流、Goal、任务、总览与自动推进 |
| [Agent 后端](backends.zh-CN.md) | 内置与外部 Agent 的连接及能力边界 |
| [多 Agent 协作](multi-agent.zh-CN.md) | 分工、调度、工作树与结果核对 |
| [运行安全与恢复](run-recovery.zh-CN.md) | 检查点、副作用、取消与恢复 |
| [任务交付](task-delivery.zh-CN.md) | 交付卡、继续修改与回滚 |
| [终端与显式验收](terminal-and-acceptance.zh-CN.md) | 执行目录、命令与任务验收 |
| [会话分支与后端诊断](branches-backends-evaluation.zh-CN.md) | 分支操作、连接诊断和项目评测 |
| [Trellis 兼容](trellis-compatibility.md) | 工程规范、任务关联与状态写回 |
| [消息反馈](message-feedback.md) | 复制与回答反馈 |
| [主题说明](theme-glass.md) | 主题与视觉验证 |
| [已知问题](known-issues.md) | 当前限制与完成判据 |

英文说明：[Canvas and goals](canvas-and-goals.md) · [Backends](backends.md) · [Multi-agent](multi-agent.md) · [Run recovery](run-recovery.md)。

## 评测与验证

- [自动化评测运行与验收](agent-evaluation-operations.zh-CN.md)
- [编码能力评测](coding-eval.zh-CN.md)
- [按 Anthropic 教程运行评测](agent-evals-anthropic.zh-CN.md)
- [公共基准接入](../benchmarks/README.zh-CN.md)
- [固定回归基线](../baselines/rag-regression-v3/README.md)
- [人工审查材料](../reviews/rag-human-audit-v1/README.md)

## 设计方案

方案描述演进方向；实际能力与验证范围以对应使用说明和验证记录为准。

- [借鉴 Super-agent 的产品与架构方案](proposals/task-coordination-proposal.zh-CN.md)
- [产品与工程改进方案](proposals/project-improvement-proposal-2026-11-15.zh-CN.md)
- [Agent 效率与任务完成率改进](proposals/agent-efficiency-improvement-plan.zh-CN.md)
- [自动化评测体系设计](proposals/agent-evaluation-system-design.zh-CN.md)
- [长期目标与 Agent 后端演进](proposals/agent-harness-and-workflow-recommendations.md)
- [会话历史分支与工作区状态](proposals/conversation-history-tree-improvement-proposal.md)

## 评审与问题分析

- [产品与工程评审](assessments/project-review-2026-11-14.zh-CN.md)
- [用户吸引力与商业价值评估](assessments/business-value-assessment-2026-11-14.zh-CN.md)
- [失败轨迹归因](assessments/failure-attribution-2026-11-01.zh-CN.md)

## 目录与产物约定

| 目录 | 用途 |
| --- | --- |
| `docs/architecture/` | 当前架构图 |
| `docs/screenshots/` | 项目介绍使用的截图 |
| `docs/validation/` | 文档或运行诊断使用的验证记录 |
| `docs/archive/` | 历史架构资料 |
| `docs/development-log/` | 按日期追加的开发日志，规则见 [日志说明](development-log/README.md) |
| `docs/eval-reports/` | 本地生成的评测报告，默认不入库 |
| `out/` | 测试截图、实验轨迹和冻结源码等生成产物 |
| `output/` | 人工交付的文档、PDF 和设计稿 |
| `release/` | 安装归档、更新元数据与打包记录 |

新方案和评审按以上目录归档，并同步维护引用。`out/` 和报告目录可能包含分析依据，清理前核对引用；固定基线、人工交付、工程与会话数据保留。下载缓存、字节码及临时打包文件可在未使用时清理。`dist/` 是直接启动所需的前端构建，`node_modules/` 和 benchmark 虚拟环境是开发依赖。

开发工具入口见 [脚本导航](../scripts/README.zh-CN.md)，贡献约定见 [开发指南](../CONTRIBUTING.zh-CN.md)。
