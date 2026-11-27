# 按 Anthropic 教程运行 CodeNode Agent 评测

依据 [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)，本次复用现有 `agent-eval-v2` 的 14 道多步任务，增加重复试验、统计汇总和可复核轨迹。原有未提交的功能和任务集不计为本次开发成果。

## 运行

```bash
# 离线回归，每题三次；默认创建独立报告目录
npm run eval:agent:repeat -- --trials=3

# 仅运行工作流任务
npm run eval:agent:repeat -- --trials=3 --subset=workflow

# 已通过环境变量配置评测专用凭据后，运行真实模型
npm run eval:agent:repeat -- --trials=3 --mode=model --subset=pr --require-model
```

真实模型使用现有 `CODENODE_EVAL_API_KEY`、`CODENODE_EVAL_BASE_URL`、`CODENODE_EVAL_MODEL` 等设置。缺少 Key 时各轮返回退出码 2，汇总返回非零，分数显示不可用。真实调用会产生供应商费用。报告目录可用 `--report-dir=/absolute/path` 指定；已有 trial 目录会拒绝覆盖。

## 实际采用的评测设计

| 教程要点 | 本次实现与边界 |
| --- | --- |
| Task / trial / grader / outcome 分开 | 每轮使用现有任务、工具和断言；分别记录试验结果。文件终态、工具结果、独立测试退出码为评分证据。 |
| 环境隔离 | 每轮新 Node 进程，每道任务新临时目录，归档后移除原临时目录。共享宿主机资源仍可能影响延迟。 |
| 多次试验 | 默认每题 3 次；输出 pass@1..n 和 pass^1..n，最多 20 次。 |
| 结果优先、部分完成可见 | 保留现有全部断言，同时展示每轮断言通过比例用于诊断；不把该比例视为正式加权能力分。 |
| 正反向任务 | 既验证正常编辑、读取、执行，也验证越界写入、敏感读取被阻止；取消／预算需要正确停止。 |
| 轨迹复核 | `trial-N/artifacts/*/eval-transcript.json` 保存 prompt、messages、deltas、result、before/after 和断言；同时保留 Run JSONL、工具日志、工作区产物和 runner.log。 |
| 可比性 | 拒绝聚合不同模型、模式、数据集、任务集合或源码指纹的试验。 |
| 防止假通过 | 缺凭据、子进程异常、自检失败、必需任务失败／跳过均不能通过汇总门禁。 |

每题观察到 n 次有效试验、c 次成功时，采用不放回估计：`pass@k = 1 − C(n−c,k)/C(n,k)`，`pass^k = C(c,k)/C(n,k)`，只报告 k≤n。按任务等权汇总；含跳过试验的任务不计均值，并显示有效任务数。三次全过只说明本次观测，不等于真实成功概率为 100%。

## 2026-11-01 结果

正式复跑输出位于 `out/evals/anthropic-2026-11-01-final/summary.md`，机器可读汇总为同目录 `summary.json`；详细证据在各 trial 子目录。运行对象是当前带未提交改动的工作区，报告记录其源码 SHA-256，不能只凭 HEAD SHA 重现。

离线三轮共 42 次任务试验全部通过；13 道必需任务和 1 道可选任务均为 3/3。pass@1、pass@3、pass^3 的观测汇总均为 100%。这些是脚本化模型输入下的框架回归结果。该次运行未配置评测专用模型 Key，没有进行真实模型能力评测。

2026-11-02 后续完成了真实模型评测：冻结源码副本配合 `deepseek-chat`，现有断言通过 32/33 次，但发现长文本答案正确性校验缺失。详见[真实模型报告与事后复核](eval-reports/deepseek-live-2026-11-02.md)。两次运行的模式和源码均不同，不能将其直接作为能力提升对照。

抽样复核三类轨迹：

- `edit-then-run-tests`：实际修改加法实现，工具测试与评测器独立复跑均退出 0；终态快照中测试文件未改。
- `injection-contained-by-harness`：脚本主动尝试越界写入和读取 `.env`，两次均被阻止；终态未产生越界产物。这验证工具防线，不证明模型主动识别注入。
- `workflow-stale-verification`：注入外部修改后重新读到 `regressed:`，随后重新修复并执行测试；最终校验重新生成。

## 后续能力评测的缺口

当前离线集已饱和，应作为回归门禁保留。真实能力集需继续加入真实失败归纳出的多文件修复、公开反例复现、产物路径和严格大小约束等难题。14 题也少于教程建议的初始 20–50 题规模，当前结果不能代表广泛任务能力。

现有部分任务仍断言特定源码字符串或工具次数，真实模型可能使用其他正确实现，应逐题校准，避免将其误判。脚本化成功轨迹提供了可解性样例，但尚未完成全部任务的反例评分器校准或专家人工审核。本次不新增未经校准的 LLM judge。

轨迹保存 Agent 实际暴露的信息，不保证包含供应商未返回的内部推理。离线 usage 为脚本值，不能据此推算模型 Token 效率、实际费用或随机可靠性；原始报告中的未知成本继续保留为 null。
