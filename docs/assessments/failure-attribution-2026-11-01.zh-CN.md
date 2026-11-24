# CodeNode 失败轨迹归因（2026-11-01）

结论：当前最优先排查的是执行工具契约、工作目录与验收闭环。预算／上下文确有问题，但不是这批失败的唯一根因。没有足够证据把主要损失归为机械重复调用。

分析覆盖冻结版本的 18 次首次模型尝试，使用独立评分恢复后的结果识别 10 条失败轨迹；同时保留 8 条通过轨迹作对照。新增付费求解、评分和修复实验均为 0。只读取旧日志与解题镜像；镜像取证使用未启动的临时容器，不运行 Agent。当前源码不是本批求解器，所有代码解释以冻结归档为准。

## 1. 逐题停止机制与未完成点

“停止机制”是可观察事件，不等于唯一根因。10 条失败中有 4 条硬预算拒发、1 条计划收尾、2 条请求超时、1 条 HTTP 尝试上限、2 条 COMPLETED 后仍评分失败。此前把两条带 budget_wrapup 的轨迹都理解为主动收尾不准确：SymPy 改进组是在硬拒发后生成本地交接。

| 任务 | 组别 | 可确认的失败链 |
| --- | --- | --- |
| django__django-11265 | baseline | 硬预算挡住后续请求；反例仍失败；环境／命令协议消耗明显 |
| django__django-11265 | improved | COMPLETED 但题面 exclude 反例未修复，普通模块回归不足以验收 |
| django__django-16100 | improved | 仅 1 轮成功响应后请求总时限触发；另有测试执行后报告生成的 SSL 异常 |
| sympy__sympy-16792 | baseline | 浏览定位后请求超时；没有留下源码补丁 |
| sympy__sympy-16792 | improved | 无补丁；环境探测与未知请求结算后硬预算拒发；不是计划主动收尾 |
| terminal-bench/schemelike-metacircular-eval | baseline | 已写 eval.scm，但 63/63 反例失败；递归错误未解决时预算耗尽 |
| terminal-bench/schemelike-metacircular-eval | improved | 缺少要求的 /app/eval.scm；保留了诊断脚本后转入收尾 |
| terminal-bench/torch-tensor-parallelism | baseline | COMPLETED 但文件写在 /parallel_linear.py，要求位置缺失；6 次终端尝试均未成功 |
| terminal-bench/write-compressor | baseline | 文件存在且解码正确，但 2562 > 2500 字节；未满足大小约束时预算耗尽 |
| terminal-bench/write-compressor | improved | 5 次 HTTP 尝试上限终止；评分恢复后要求的压缩文件仍未达标 |

## 2. 已确认的主要问题

### P0：终端名称、参数语义和可用程序不一致

18 条轨迹共 203 次 execute_shell 尝试，发现 40 次白名单拒绝、25 次程序解析 ENOENT、6 次有明确报错证据的 shell 运算符被当 argv。这些标签可能重叠，不能相加当作独立失败数；通过轨迹也出现 14 次白名单拒绝，单个拒绝并不必然导致任务失败。

直接证据包括 pip 把 `tail -5` 的 `-5` 当选项、Django 测试入口把 `2>&1 | tail -20` 当参数。来源相同的冻结工具在隔离临时目录复现：`python3 -c … 2>&1 | tail -5` 的 Python 实际收到 `["2>&1","|","tail","-5"]`；`ls` 被拒绝。复现没有模型调用或网络访问。普通入口直接 spawn，不解释 shell 运算符；Linux shell 需要经不直观的 `cmd` 包装，额外引入转义负担。

[pip 参数错误](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-baseline-django__django-11265/django__django-11265__YzskRsb/agent/codenode.jsonl:7183) · [测试参数错误](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-improved-django__django-11265/django__django-11265__zfjXAbG/agent/codenode.jsonl:4381) · [独立复现与结果](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/shell-contract-probe.json)。

后续建议：在评测容器中明确区分 executable/argv 与 POSIX shell 脚本；同时公开当前执行模式和可用命令。宿主机审批、路径与网络限制应继续保留，不宜把“扩大所有白名单”当作修复。只有 6 次是报错明确命中的下界；静默被忽略的 `&&` 不按字符串出现次数武断计为失败。

### P0：读写根目录与任务工作目录缺少统一验收

Terminal 的工具根是 `/`，题目工作目录是 `/app`。PyTorch 基线把文件写到 `/parallel_linear.py`，要求的 `/app/parallel_linear.py` 不存在；它还写了测试脚本，但 6 次终端调用分别遭白名单拒绝或 ENOENT，之后仍 COMPLETED。解题镜像离线取证确认错误位置的文件存在（6686 字节），要求位置缺失。这足以解释本次交付失败，不证明仅移动文件就能通过数学正确性测试。

[最后写入调用](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/setup-recovery/jobs/07-baseline-torch-tensor-parallelism/torch-tensor-parallelism__qFXxB2t/agent/codenode.jsonl:14194) · [镜像文件位置校验](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/filesystem-checks.json)。

模型确实未遵守初始绝对路径提示；harness 也没有在完成前挡住明确的产物位置错误。后续应将“访问范围根”与“默认工作目录”分开，并按公开任务契约核查必需产物；不通过隐藏评分来指导正在求解的模型。

### P0/P1：验证没有覆盖公开题面反例，完成状态过早

Django 11265 改进组运行了 filtered_relation、queries、lookup、aggregation 等可见回归且获得退出码 0，但补丁只改 query.py（另带自动 .bak），没有观察到将题面明确给出的 exclude 场景变成新增测试或独立复现。后置评分中的新反例仍失败。因此这是“已有回归通过”被当成“问题已修复”的验证缺口，不能只归因为预算。

[最后回归调用](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-improved-django__django-11265/django__django-11265__zfjXAbG/agent/codenode.jsonl:4583) · [原始公开反例](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-improved-django__django-11265/django__django-11265__zfjXAbG/agent/instruction.txt) · [实际补丁](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-improved-django__django-11265/django__django-11265__zfjXAbG/agent/prediction.patch)。

Scheme 改进组的镜像中 `/app/eval.scm` 不存在；诊断 Python 脚本运行过，但其中一次子进程报告 rc=2，外层脚本仍 exit 0。工具成功、外层进程成功与验收通过必须分别记录。基线 Scheme 有真实递归语义错误；基线压缩器已通过存在／解码检查，仅大小仍超 62 字节。后两类包含实际求解难度，不能把失败全部解释成 harness 能自动补救。

### P1：解释器环境发现过晚

18 条轨迹中记录了 16 次带 ModuleNotFoundError/ImportError 的终端结果。Django 基线使用根环境 Python，反复遇到 pytz/sqlparse；改进组较晚才找到 `/opt/miniconda3/envs/testbed/bin/python`。SymPy 改进组也在环境探测中遇到 mpmath/numpy 缺失。ENOENT 只说明当前执行环境无法解析程序，不足以断言镜像没有解释器。

[解释器确认](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-improved-django__django-11265/django__django-11265__zfjXAbG/agent/codenode.jsonl:3376) · [使用 testbed 解释器的回归](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/jobs/00-improved-django__django-11265/django__django-11265__zfjXAbG/agent/codenode.jsonl:3933)。

建议在首次求解前只做一次可追溯的 cwd／解释器／可执行程序发现，优先复用题目环境，不让模型通过多轮 pip 安装和 Windows 风格包装摸索基本执行方式。

## 3. 预算与回收：有实证，但要拆开解释

### 压缩为 0 的直接原因：未发起，而非摘要模型失败

9 条改进轨迹共 156 次预算评估：136 次 sufficient-budget、20 次 no-net-savings；没有 compaction_start，也没有 compaction 成本记录。5 条轨迹进入过后一个判据。当前候选方案的尾部保留与摘要开销在预测中不划算，入口被正确执行但没有产出可用的回收候选。

代表例：Scheme 改进组最后一次规划，输入 122318、预测压后输入 83477、摘要预留 92514，预测两轮净节省为 `2 × (122318 − 83477) − 92514 = −14832`，所以没有压缩。Django 改进组甚至预测压后输入 91150 大于原输入 83761。冻结源码使用 12000 token 尾部和 `maxOutputTokens × 4` 字符占位摘要；这些是需要校准的预测与保留策略，不是对实际摘要收益的测量。

[预算原始记录](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/evidence/improved-schemelike-metacircular-eval/tools_trace.jsonl:163) · [预算原始记录](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/evidence/improved-django__django-11265/tools_trace.jsonl:161) · [冻结预测代码](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/frozen-runtime/electron/budgetCompaction.cjs)。

### 字节预留、未知请求结算和已知 usage 不是同一个量

10 条失败轨迹中，规划输入与顺序对齐的成功主请求 prompt usage 的比值中位数约为 3.06–3.92。规划发生在部分提示注入之前，口径并非完全相同；该比值只能说明保守程度，需要精确请求体与模型 tokenizer 重放才能校准，不能据此直接放宽硬上限。

例如基线 Scheme 没有未知 usage：已用 501974、剩余 98026、下一输入规划 137630，发送前拒绝可直接核对。改进 SymPy 则不同：已知主请求 192292，4 次未知请求累计预留 337863，最后硬预算已用 530155、剩余 69845。日志中的账本显示和硬预算结算也不同；未知预留不等于供应商实际收取这些 Token。这里既有请求层不稳定，又有保守结算放大后续预算压力，不能全归为历史太长。

[预算原始记录](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/evidence/baseline-schemelike-metacircular-eval/tools_trace.jsonl:107) · [SymPy 收尾与预算记录](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/evidence/improved-sympy__sympy-16792/tools_trace.jsonl:128)。

Scheme 改进组的计划收尾发生时，余额 108846 已小于正常请求输入规划 122241；这次收尾提供了交接，没有证明它为下一轮有效解题保住了额度。改进压缩器终止于 5 次 HTTP 尝试上限，未知请求预留累计 327245；日志不足以继续区分服务端、传输或客户端解析的具体根因。

## 4. 无进展提示为 0，不等于已经证实机械空转

改进组 147 次观测中，68 次 workspace-version-unknown、75 次 new-evidence、3 次合法等待／交互排除、仅 1 次 repeated-action-and-result，未达到提示阈值。日志未细分未知版本来自链接、扫描数量还是字节上限。Terminal 根 `/` 的全树快照容易不完整，是源码支持的解释，尚不是每次排除的独立实测原因。

10 条失败中只有基线压缩器出现 1 次参数与结果完全相同的重复调用；这些重复也可能是合理复测。主要可见摩擦是“不断更换命令去绕过执行限制／发现环境”，并非单纯同命令死循环。后续应先补排除原因和针对性文件版本信号，再评估相同失败类别反复出现；不应直接降低阈值或硬性打断。

## 5. 环境与观测边界

已保留的准备 DNS 失败、PyPI／压缩器评分启动失败与首次模型求解分开。另在 Django 16100 改进组评分 stdout 中发现获取测试依赖元数据的 requests.exceptions.SSLError，且没有 report.json。逐段核对确认：测试已经运行 71 项、失败 1 项，SSL 出现在随后 make_test_spec／报告生成阶段。这不是“测试未启动”，不能仅按关键词归入启动失败。该任务同时存在求解请求超时、已执行测试失败和评分报告异常；本次保留这些层次，不改原始分数，也不启动评分恢复。

分析发现旧分析字段 mainUsageTokens 来自最终 result.usage；部分收尾路径会把 handoff usage 合并进去，并不总是纯主请求。本报告改用成本记录 kind 拆分 knownMainTokens、knownHelperTokens 与未知预留，避免把账本估算当实际 usage。SSE reasoning/tool 分片数不当作轮次数。

补丁还有次要交付问题：Django 11265 两份预测约 124 KB，大量内容来自工具自动生成的 .bak。它没有被认定为本次评分失败原因，但应区分用户产物和工具衍生产物，避免污染交付与审阅。

## 6. 建议的单项修复与验收顺序

1. **执行契约／cwd**：普通程序 argv 与 shell 脚本明确分离；测试 pipe、重定向、&&、带空格参数；公开任务 cwd 与访问根独立，并验证 `/app` 产物定位。先跑本地契约回归，不支付新的模型求解。
2. **复现与验收证据**：对公开反例记录修改前失败、修改后通过的同一命令及调用 ID；COMPLETED 前核查公开要求的文件与大小／存在性。退出码、API ok 和验收状态分离。
3. **环境预检**：一次确定可用解释器／编译器与工作目录，记录发现依据，减少无效程序探测。
4. **预算与恢复候选**：先修复以上摩擦，再离线重放“尾部保留／摘要成本”的单项候选；同时分离已知用量、未知预留、重试及停止原因。保持父子预算与费用硬上限。
5. **无进展范围与遥测**：补请求阶段、TTFT／最后 chunk、重试原因与单调时钟；补快照不完整的原因码。只在证据足够时测试失败类别循环提示。

这些是基于可观察链条的优先顺序，不是已证明能补过多少题的收益承诺。先做单项离线修复，再决定是否开展新的固定预算模型对照。

## 证据与复现

[逐条命令与行号核对表](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/inventory.md) · [18 条结构化归因数据](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/attribution.json) · [镜像文件检查](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/filesystem-checks.json) · [冻结源码取证目录](/Users/Admin1/Documents/ChatGPT/CodeNode/out/benchmarks/native-efficiency-ab-20261030/failure-attribution/frozen-runtime)

运行 `python3 scripts/benchmarks/attribute-failures.py out/benchmarks/native-efficiency-ab-20261030` 可重建机器核对数据；需要保留同目录的历史轨迹和已提取镜像证据。镜像取证没有启动镜像中的命令。源文件与提取记录均带 SHA-256，原始评分和轨迹未被写回。

后置官方评分仅用于本次归因，不能作为后续 Agent 正在求解时的提示。
