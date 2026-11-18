# CodeNode 评测度量与评分器校准：第一轮

[English](evaluation-measurement-calibration.md) · [简体中文](evaluation-measurement-calibration.zh-CN.md)

更新日期：2026-11-17。状态：离线工程与校准；独立人审待完成；不授予能力发布许可。

## 本轮解决的问题

之前的 `execute_shell` 将程序不在白名单、执行模式被禁用、工作目录错误都返回为 `ARG_SCHEMA`。因此“首次调用被接受”不能直接解释成“模型会正确填写 JSON”，更不能解释成“编码任务成功”。本轮拆开这些证据，并用真实历史缺陷校准评分器。

本轮没有新增真实模型请求，没有重新开放已关闭的确认实验预算，没有修改历史实验的计划、评分或主指标。下面的任务数与结果属于离线校准，不能混入模型成功率。

## 工具错误与度量版本

| 结果 | 新代码或诊断维度 | 可以说明什么 |
| --- | --- | --- |
| 参数缺失、类型错误、混用两种调用格式 | `ARG_SCHEMA` / argument | 本次参数没有通过契约检查 |
| 程序不在执行白名单 | `PROGRAM_NOT_ALLOWED` / policy | 策略拒绝程序；反馈中附 `allowedPrograms` |
| 普通桌面请求评测专用 shell 模式 | `EXECUTION_MODE_DENIED` / policy | 当前环境不允许该模式 |
| cwd 越过授权边界 | `CWD_OUT_OF_ROOT` / policy | 路径边界拒绝 |
| cwd 不存在或不是目录 | `CWD_NOT_FOUND` / argument | 需要纠正工作目录 |
| 可执行程序未能启动 | `SHELL_START_FAILED` / infrastructure | 启动失败，不能算测试断言失败 |
| 程序实际运行，退出码非零 | `PROCESS_EXIT_NONZERO` / execution | 命令失败；工具调用仍可为 `ok=true` |
| 超时、取消、预算、未登记失败 | 各自单列 | 保留运行原因；证据不足时不推断参数或策略已通过 |

`PROCESS_EXIT_NONZERO` 是从退出码计算的诊断标签，不是新增运行时失败码。`ok=true` 不能代替退出码检查。

新计划显式冻结 `primaryMetricVersion: tool-outcome-v2`；argument 和 policy 拒绝均使首次契约接受指标为 0，无法判定时为 null。取消、预算检查和意外系统错误可能在参数验证之前发生，不能仅凭没有 `ARG_SCHEMA` 就记为接受。已有未声明版本的计划保留 `legacy-arg-schema-v1` 规则，重分析若发现原主指标漂移会拒绝。

历史迁移仅针对失败调用中与旧实现完全匹配的白名单、模式错误前缀。旧的“cwd 不存在或越过授权边界”无法区分两种原因，标为 unknown，不猜测。新的诊断分别记录 argumentAccepted、policyAccepted 和 invocationAccepted；它们都不表示任务验收通过。

## 12 条已有模型轨迹的离线结果

输入来自固定确认实验 [GitHub run 43797984829](https://github.com/yimi528/CodeNode/actions/runs/43797984829)：2 道小任务、2 个组、每组每任务 3 次。归档保留原计划封印、运行源码、独立验收和原生事件。重分析校验原生结果中的工具调用与事件一致，并记录输入及分析代码哈希。

| 组别 | 观察到首次调用 | 参数被接受 | 策略拒绝 | 调用契约被接受 | 未知 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 6 | 6 | 0 | 6 | 0 |
| improved（额外 argv 示例） | 6 | 6 | 3 | 3 | 0 |

3 次拒绝对应 `ls`、`ls`、`bash` 的白名单限制；不能再称为 JSON 格式错误。原首次契约接受结果仍为 6/6 对 3/6，12 次任务验收均通过，原收益结论仍为 inconclusive。参数轴的 6/6 对 6/6 是解释错误原因的诊断结果，不是新的收益确认。

重跑命令要求输入完整归档，输出必须是原始证据之外的新目录：

```bash
npm run eval:calibrate-traces -- \
  --input=/absolute/path/to/model-evidence \
  --output=/absolute/path/to/new-trace-analysis
```

输出 `summary.json/md` 保留原指标，`tool-metrics.json/md` 增加版本化诊断。该命令不调用模型或重新运行验收；它不能产生新的独立人工判断。

## 真实仓库历史缺陷的首批入口

注册表为 `config/repository-eval-calibration.json`，所有来源固定到完整 Git commit。来源均为 CodeNode 自身历史中的真实模块回归，不是跨仓库 benchmark，也不是完整桌面应用构建验收。

| 案例 | 验证行为 | 校准结果：初始 / 参考 / 等价 / 错误 / 伪成功 |
| --- | --- | --- |
| repository-null-tools | 无工具上下文时纯聊天仍执行并完成 | FAIL / PASS / PASS / FAIL / FAIL |
| repository-deepseek-history | 工具回合及长度续写保留 reasoning 历史 | FAIL / PASS / PASS / FAIL / FAIL |
| repository-budget-accounting | 拒绝非法预留，未知计费保守扣账且不重复结算 | FAIL / PASS / PASS / FAIL / FAIL |
| repository-partial-boundary | 小样本边界不伪报收益，大样本正向对照仍可通过 | FAIL / PASS / PASS / FAIL / FAIL |

四题共 20 个变体实际执行。参考修复通过只能证明有一个可接受实现；等价实现、错误修复及伪成功对照分别检查评分器不会只认补丁字面、不漏掉已知错误、不把 `console.log('PASS'); process.exit(0)` 当作验收完成。没有声称覆盖了所有正确实现或所有作弊方法。

评分器在临时目录解包 base commit 的 `electron/`、`scripts/lib/`、`config/`、包元数据和 LICENSE，叠加指定版本的候选模块。验收程序位于候选目录之外，通过已有模块和脚本模型执行行为断言。宿主已安装依赖被显式复用，依赖锁哈希与平台记录在报告中；准备失败、缺依赖和超时记为 ERROR，不能用来声称原始缺陷复现。

验收需要可信包装器在检查完成后输出唯一、带本次 nonce 和任务 ID 的结构化回执；只退出 0 或打印 PASS 不通过。这是对可信注册变体的进程内校准，nonce 并不是针对恶意代码的安全边界。默认 fetch 拦截也不是网络隔离证明。

```bash
# 需要完整 Git 历史与已安装依赖；不需要模型 key
npm run eval:repository-quality -- \
  --repository=. --output=out/evals/new-repository-calibration
```

输出必须是新目录。可用 `--tasks=repository-null-tools` 选择注册任务。无任意候选补丁入口；命令不接受模型生成代码。CI 的 contracts job 使用完整 checkout，执行同样的历史变体校准并上传证据。

## 准入限制与下一阶段

四题均为 `development-calibration-only`、`modelEligible=false`、`review=unreviewed`。阻断原因分别是：自举运行时可能暴露参考修复、当前运行器只支持可信历史代码而无不可信候选的系统隔离、独立任务审查待完成。不能因离线校准通过而删除这些标记或纳入能力分数。

下一阶段仍需完成以下独立工作：

1. 建立 20–30 道有代表性的真实仓库任务，覆盖定位、跨文件修改、兼容与回归；登记来源、难度、已知污染和保留集。
2. 建立独立任务包及不可信代码验收环境，隔开 agent 运行时、初始仓库、参考补丁和隐藏测试；实际验证网络、挂载和进程限制，再考虑开放模型准入。
3. 将对照实验扩展为显式单变量配置，采集成本和失败原因，允许“没有收益”作为有效结果。
4. 分离工程回归门禁与能力收益门禁，并在采数前确定目标效应、样本量和停止规则。版本变化不得悄悄改写历史结论。
5. 由独立真人完成现有人审与新任务审查，核对评分器误判；本轮没有代签，也没有修改原来的 26 条待审记录。

当前产物能帮助定位评测错误、验证评分器和复现证据。它还不足以给出 CodeNode 在真实项目上的总体可靠性保证。
