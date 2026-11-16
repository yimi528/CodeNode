# CodeNode 自动化评测运行与验收

更新日期：2026-11-15。

当前系统已接通任务检查、冻结实验、持久证据、共享预算、独立重评、对照统计和发布检查。26 道内置任务包括 12 道编码任务，其中 2 道属于保留任务；其余覆盖机制、流程和注入场景。任务自动检查有 74 个编码校准候选，独立人工复核仍按外部证据登记。

本地 Docker daemon 已恢复，独立 grader 正反例、Harbor 主链路、原生 CLI profile 和首次读取故障变体均已在容器中实跑通过，verifier 的实际网络模式核验为 none。用户最新确认本项目只允许 yimi528/CodeNode；隔离分支的远程离线评测 CI 已实际通过。此前真实模型结果来自宿主进程诊断，不会因离线容器 smoke 通过而自动成为隔离模型成绩或发布认证。体系决策见[设计文档](agent-evaluation-system-design.zh-CN.md)。

## 本地检查

```bash
npm run eval:quality
npm run test:eval-quality
npm run test:eval-system
npm run test:eval-campaign
npm run test:eval -- --report-dir=out/evals/local-contracts
```

离线 runner 按脚本产生模型动作，实际调用工具、修改文件并验收。离线通过只证明运行与判分链路。真实模型模式使用模型自行决策；报告将两类证据分开。

## 冻结并运行对照实验

```bash
npm run eval:system -- prepare \
  --output=out/evals/my-pilot \
  --tasks=coding-timeout-default,coding-port-parser \
  --mode=offline --trials=2 --max-tokens=1000000

npm run eval:system -- run --plan=out/evals/my-pilot/plan.json
npm run eval:system -- analyze --plan=out/evals/my-pilot/plan.json
```

默认比较 baseline 与 improved，唯一声明变化是额外的 argv 工具说明示例；任务和轮次内分块随机安排组别顺序，记录种子。`--arms=single` 运行单组。使用 `--subset=robustness` 选择改写、改名和首次读取故障变体；使用 `--subset=holdout --kind=confirmation` 选择保留任务。保留任务通过不自动满足发布条件。

`prepare` 复制运行源码、依赖和配置身份，生成不覆盖的计划与完整性封印。运行时使用快照中的 runner，逐次核对文件哈希。已经写入状态的尝试不会因再次执行 `run` 而重新解题；RUNNING 或 UNKNOWN 状态需先调查。`analyze` 可重复生成派生报告，分析代码哈希写入结果；分析版本改变时旧摘要另存 `analysis-history/`，原始试验和评分保留。

真实模式将 `--mode` 改为 `model`，并通过进程环境设置 `CODENODE_EVAL_API_KEY`。模型和地址可用 `--model=MODEL_ID --base-url=URL` 明确冻结。不要把 key 放入参数、计划、源码或文档。

同一预算下追加不同任务时复用账本与快照：

```bash
npm run eval:system -- prepare \
  --output=out/evals/my-confirmation \
  --from=out/evals/my-pilot/plan.json \
  --budget-ledger=out/evals/my-pilot/token-ledger.json \
  --subset=holdout --kind=confirmation --mode=model --trials=2
```

预算在每次模型请求前预留。已返回完整 usage 的请求按供应商报告计账；计费不明、传输失败或中断的请求保留保守预留，不记作零。未结算预留同样占用额度。新计划在连续两次未获得完整模型响应后停止启动下一次尝试，不能将服务不可用的一串失败解释成编码能力。

单实验额度最多 100 万 tokens，多实验可以共享同一账本。这个限制控制推理请求；费用仍需以供应商账单为准。预算上界以请求内容 UTF-8 字节、最大输出和协议余量保守估算，若供应商报告超过预留则标记上界异常并阻止发布。

## 证据和状态

单次 runner 自动生成 `evidence-*/trials/<trial-id>/`，无需 `--keep`：

| 文件 | 内容 |
| --- | --- |
| identity.json | 尝试身份、任务、执行 profile、源码来源 |
| effective-config.json | 实际配置、预算、审批模式和额外说明开关 |
| requests.jsonl | 脱敏后的模型请求、工具 schema、响应状态与可获得的 usage 和模型元数据 |
| events.jsonl | 原生事件、工具反馈、停止及故障注入 |
| snapshots.json | 修改前后终态，用于检查与重评 |
| artifact-manifest.json | 重评输入范围、文件哈希和收集时点 |
| execution.json | 执行、评分、完整性及交付状态 |
| native-result.json | 原生结果与断言，便于定位证据 |
| grades/ | 初始与后续评分；新评分不覆盖旧评分 |
| attribution.json | 当前本地 runner 的观测和未确认原因假设 |

`executionStatus`、`gradingStatus`、`integrityStatus` 独立表达。例如预算停止时补丁可通过行为测试，但默认不算端到端交付；受保护文件被改动也不能靠测试通过抵消。工具 ok=true 仅表示工具执行成功，不表示其中运行的测试退出码为零。

报告保留全计划分母和保守交付比例，再给出可评分产物通过率。没有完整模型响应的尝试单列为 `no-completed-model-response`；产物验收失败与模型能力失败不能混为一谈。

## 独立重评

```bash
npm run eval:regrade -- /absolute/path/to/evidence/trials/TRIAL_ID process
npm run eval:regrade -- /absolute/path/to/evidence/trials/TRIAL_ID docker
```

重评验证快照与契约哈希，在新目录重建产物，运行当前 grader，保存新的 grade ID、父试验及可选父评分身份。模型调用数为零。输入被修改、符号链接、缺少完整状态或非本地 CJS 行为任务均不会被当作可重放。

依赖进程、数据库或服务状态的外部任务继续使用现有 Harbor recovery；不能只拿 patch 复原整个运行现场。新的 grader 版本应对比较两组都重评，再解释差异。

## 容器与原生执行通道

```bash
npm run eval:system -- doctor
npm run eval:system -- prepare \
  --output=out/evals/isolated-smoke --tasks=coding-timeout-default \
  --mode=offline --trials=1 --arms=single --isolation=harbor
npm run eval:system -- export-harbor --plan=out/evals/isolated-smoke/plan.json
npm run eval:system -- run --plan=out/evals/isolated-smoke/plan.json
```

Harbor 接入固定 SDK 版本，导出任务由该版本的 TaskConfig 校验。当前 Docker VM 内核未启用 SDK 动态出口控制所需的 CONFIG_NFT_FIB_INET，因此使用受限的静态 Docker provider：只允许显式声明的单服务 network_mode=none，并在启动后检查实际容器网络。它不支持将 verifier 切回公网或动态 allowlist；不通过时直接失败。解题环境与 verifier 分离；只传递声明的工作区产物，验收环境无网络。私有契约仅放在 verifier 的受限目录，候选函数在不同 UID 下运行，父进程负责比较并写分数。

容器模型请求经过控制端 broker，真正的供应商 key 留在控制端；共享账本仍在每次请求前检查。解题端仅获得短期代理凭据。离线 Harbor smoke 使用脚本 broker，不调用外部模型。Docker 或镜像不可用时明确失败，不回退到宿主执行。Buildx 状态放在实验目录，避免沙箱禁止写入用户 Docker 全局目录导致构建失败。失败的 Harbor smoke 会保留原始诊断产物。Linux agent 容器为本机 broker 显式配置 host-gateway；verifier 不配置该网络通路。

`--profile=benchmark-controlled` 保留明确的 benchmark 覆盖项；`--profile=native-product --isolation=harbor` 使用正常 headless CLI 路径，并记录新工作区、隔离 HOME、自动审批与无个人历史等差异。它不等于桌面交互或所有用户已有配置。后者仍需独立产品流程评测。

容器准备好后运行：

```bash
docker pull node:22.23.1-bookworm-slim
npm run test:eval-docker
npm run test:eval-harbor-smoke
```

## 人工复核与发布检查

```bash
npm run eval:system -- review-pack \
  --plan=out/evals/my-confirmation/plan.json \
  --output=out/evals/my-review

npm run eval:system -- gate \
  --plan=out/evals/my-confirmation/plan.json \
  --review=out/evals/my-review/reviewer/completed-review.json
```

只将 `reviewer/` 发给未参与出题的复核者，不提供控制端的 `controller-key.json`。复核者阅读题面与候选文件，填写 reviewer、独立性声明、逐题 verdict 和 notes，以及每个 candidateId 的 pass 布尔标签。机制任务没有参考补丁时只审查契约。保留原 taskHash 与 packId；不能让模型代填后声称已完成人审。

导入检查复核包身份、任务哈希、候选覆盖和标签争议；真实独立性仍依赖可信复核者的声明。缺少人审、缺乏隔离验证、覆盖不足、服务异常或统计证据不足时，gate 输出原因并非零退出。

统计报告按家族权重给出固定题集的对照差值、任务级 Wilson 区间，以及任务内重采样的区间；明确声明总体推断时才做家族聚类重采样。小样本返回证据不足；固定题集的饱和样本改用声明独立性假设的 Hoeffding 联合保守界限，总体推断下的饱和样本不提供伪精确区间，不把零宽 bootstrap 区间当作确定结论。当前实现未默认自动扩样以追逐显著性。

## CI 配置

[agent-evaluation.yml](../.github/workflows/agent-evaluation.yml)包含相关 PR 的离线契约与证据测试、Docker verifier 和 Harbor smoke，以及显式启用的有预算模型 pilot。评测 PR 不接收模型 secrets；专用真实模型工作流只有手动触发或设置 `CODENODE_EVAL_SCHEDULED=true` 后才运行。默认定期离线测试不产生模型费用。

CI 上传原始证据与报告。实验执行成功不等于发布检查通过，正式发布需读取 gate 结果。本项目按用户最新明确指示只使用 yimi528/CodeNode。工程集成已通过 PR #27 合入 main（800212a），合并前后均通过三平台回归、生产门禁和打包。原工作区 yimi-branch 的未提交内容保留；人审没有因此转为通过。

## 本次真实模型诊断结果

模型服务标识为 `deepseek-chat`，29 次尝试使用同一冻结的实验运行时；这些早期记录没有完整保存供应商底层版本信息，不能从当前模型列表补填。后续请求记录已增加响应模型元数据字段。

| 实验 | 结果 | 可得结论 |
| --- | --- | --- |
| argv 示例 pilot | baseline 5/6 交付，improved 6/6；主指标差值区间包含 0 | 当前证据无法确认收益 |
| 两个保留任务诊断 | 两组各 2/4 交付；后续部分请求无完整响应 | 确认数据不足，不能作为正式保留集能力结论 |
| 三个可靠性变体首次运行 | 0/6 交付，均未获得完整模型轮次 | 服务可用性不足，不代表模型编码成功率为零 |
| 恢复后的补充诊断 | 改名、改写、首次读取故障各一次，共 3/3 交付 | 仅证明三次观察中的可完成性，不替换原始失败 |

该轮宿主诊断结束时，共享账本记录供应商已报告 482,782 tokens、保守计账 882,845 tokens、未结算预留 0，上限 1,000,000。未知计费仍为未知，未估算金额。没有继续调用模型来把失败刷成通过；新增云端试验继续使用这份累计授权。

本机证据目录为 `out/evals/system-20261114-pilot/`、`system-20261114-confirmation/`、`system-20261114-robustness/` 和 `system-20261115-recovery/`。这些生成产物不会随源码自动提交，应通过受控工件存储保留。本次全任务待复核包位于 `out/evals/system-20261115-review-pack/reviewer/`。

## 原仓库示例与历史要求

[项目示例](../config/project-eval.example.json)显式使用 `repository.snapshot=tree`：对固定提交只读导出树，在临时目录新建 Git 基线，不修改源仓库，也不保留原历史。它避免 partial clone 为打包无关历史而尝试写入源 `.git`，记录原提交、原树和新工作区提交。

依赖原始历史的任务应选择 `snapshot=history` 或省略该字段，继续使用原始 clone 语义；缺失对象或权限不足会报告准备失败，不能静默改为无历史仓库。


## 2026 年 11 月 15 日容器验收记录

独立 Docker grader 的正确实现与伪造成功输出反例均通过验收。Harbor 的 benchmark-controlled、native-product、首次读取故障三条离线链路均交付 1/1，原始 verifier reward=1、exception_info=null；故障变体确实注入一次 read_file 失败，后续读取成功。每条链路都保存了独立 verifier 的 containerId、networkMode=none 和 enforced=true，不依赖静态配置推测隔离。

持久证据分别位于 `out/evals/container-acceptance-20261115-passed/`、`out/evals/container-native-acceptance-20261115/`、`out/evals/container-fault-acceptance-20261115/`。失败尝试同样保留，未覆盖为成功。以上全部使用脚本模型，供应商 token 计账为 0。


## 远程 CI 验收记录

[运行 43687779566](https://github.com/yimi528/CodeNode/actions/runs/43687779566) 绑定提交 `5924dfb8c937c6d0a319f85f6fe3ee15bddcc7b1`，结果为 success。`contracts` 与 `isolated-verifier` 均实际成功执行：全量离线任务、评分器、证据与成对试验测试、固定依赖安装、Docker 正反例和 Harbor 分离 verifier smoke 通过，契约证据工件上传成功。应用 Verify、Package 和 live-pilot job 按专用模式跳过；此结果不是产品打包发布或独立人审通过。


## 持久预算、隔离真实模型和能力发布

用户本轮明确继续原总额度：总上限 1,000,000 tokens，交接时保守已用 882,845，剩余 117,155；不新增额度。实际余额以 `codex/agent-evaluation-budget` 分支的 `state.json` 为准，而不是静态文档数字。该分支只存无密钥账本与执行锁，不存产品代码。

付费入口为 `agent-evaluation-live.yml`。使用独立 secret `CODENODE_EVAL_ISOLATED_KEY`，模型和地址由 `CODENODE_EVAL_MODEL`、`CODENODE_EVAL_BASE_URL` variables 固定；不会给旧的无共享预算模型 job 配置 key。任务先原子取得远程执行锁，再复制原账本；所有请求仍先预留后结算。结束时以原文件 SHA 更新账本；中断、写回失败或未知预留均会阻止继续调用，不自动清锁或重置预算。旧宿主账本交接后仅为只读镜像。

```bash
gh workflow run agent-evaluation-live.yml --repo yimi528/CodeNode -f purpose=confirmation
# 只有显式启用且余额足够，周任务才执行一次单题 diagnostic。
gh variable set CODENODE_EVAL_SCHEDULED --repo yimi528/CodeNode --body true
```

confirmation 预先固定现有两个保留任务、每组两次、baseline/improved 分块随机顺序，使用 native-product profile、Harbor 解题环境、独立无网络 verifier 和原 argv 单变量。题目此前已经观察过，本轮是固定题集复验，不作为全新未见题泛化证据。预算不足时保留全部计划分母和未执行项，不缩小样本冒充完成；服务连续无完整响应时停止。统计不支持收益同样是有效报告结果。不得扩大预算或反复运行来追逐显著性。

输出工件 `agent-evaluation-live-evidence` 包含冻结计划、源码提交、模型请求、逐次产物、统计、待人审盲评包与 gate 决策，保留 90 天；账本单独持续保存，不受工件到期影响。原 26 题人审模板继续待完成，不替换或代签。运行记录见 [隔离模型工作流](https://github.com/yimi528/CodeNode/actions/workflows/agent-evaluation-live.yml)。

发布模式必须给 production-gate 的 `capability_run_id` 提供当前同一提交的已完成确认实验。工作流调用 `capability-release.yml`，核对仓库、触发类型、工作流、提交和冻结代码身份，下载证据并重新执行 `eval:system gate`。独立复核完成后才可设置 `CODENODE_EVAL_INDEPENDENT_REVIEW` JSON secret；缺少时保持拒绝。诊断工作流执行成功、模型偶尔通过和能力发布通过分别记录。

```bash
# 无人审时这项检查应失败，这是实际拒绝，不是豁免或批准。
gh workflow run capability-release.yml --repo yimi528/CodeNode -f evidence_run_id=RUN_ID
```

当前人审仍待完成。正式实验是否覆盖完整、统计能支持什么结论，以及剩余余额，以对应 Actions 工件和生成报告为准；工程 smoke、历史宿主模型报告与新隔离结果不相互回填。


## 当前供应商契约核对

本轮通过供应商 `/models` 查询确认凭据有效，当前返回 `deepseek-flash` 和 `deepseek-v4-pro`；新实验固定使用 `deepseek-flash`，不把旧 `deepseek-chat` 诊断与新模型结果合并。元数据查询不产生生成 tokens。实际返回的模型标识、response ID 和 fingerprint 由请求证据记录，未提供的底层版本保持未知。

当前 DeepSeek 思考工具轮次要求完整回传 reasoning_content；源码在工具结果、截断续写和校验重试中保留该字段，仅 DeepSeek 的 OpenAI 格式请求发送它，其他 OpenAI 兼容端点保持原格式。零外部调用的 test:deepseek-reasoning 先复现了字段丢失，再验证真实工具循环、无工具续写及其他模型的负向约束。契约来源：[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。


## 2026-11-15 真实隔离运行与预算停止

[运行 43697561600](https://github.com/yimi528/CodeNode/actions/runs/43697561600) 使用提交 f113444、deepseek-flash、native-product profile、Harbor 解题环境及独立无网络 verifier。计划为两题、两组、各两次，共 8 次；实际启动 4 次，完整交付 1 次，2 份产物独立验收 PASS。其余已启动尝试均遇到控制端预算预检拒绝，4 次未启动。不能将这些未交付记录解释为模型编码失败率或服务中断率。

本轮供应商实际报告新增 63,830 tokens；累计已报告 546,612，累计保守计账 946,675，未结算预留 0，余额 53,325。已观测的 native-product 初始请求需要 70,404 tokens 预留上界，高于当前余额；预留上界不等于实际消耗。周期入口已经配置启用，低于启动门槛时先归档 budget-status.json，跳过依赖安装、模型执行和新计划准备，不重置原额度。

原生错误位于 event.delta.error，且最终 result 可能只有 FAILED 状态，没有 error 字段。导入器现在优先读取原生错误，再考虑 Harbor 的命令异常；EVAL_TOKEN_BUDGET 标为 BUDGET_EXHAUSTED / budget-not-funded。原始云端报告保留，修正分析另存为带 analysisId、代码哈希、输入哈希和原实验身份的新报告，不重跑模型，不改独立评分或首个 Shell 指标。

```bash
npm run eval:reanalyze-harbor -- \
  --input=/absolute/path/to/downloaded/live-evidence \
  --output=/absolute/path/to/new-analysis
```

重分析核对计划封印、冻结源码、任务身份和产物哈希，支持把原 CI 的绝对路径安全映射到下载目录。输出必须是原证据之外的新目录。现有 8 次计划分母、4 次未启动和原 grade 均保留；新版分析中服务无完整响应为 0，3 次属于预算停止。正式收益确认仍为 insufficient-evidence / 未完成，不申请新增额度。

[生产发布检查 43697937003](https://github.com/yimi528/CodeNode/actions/runs/43697937003) 已实际调用能力门禁并拒绝放行：确认覆盖不完整、缺人审且统计证据不足；原有发布凭据检查也未通过。工程工作流成功不等于发布获准。原 26 题人审仍待完成，独立复核 secret 未填写。后续分析修复不冒充新的解题尝试；发布检查仍严格要求证据匹配提交。


## 2026-11-16 增量授权确认实验

用户新增明确授权最多 1,000,000 tokens，耗尽即停，用于完成固定确认计划。该授权不是供应商充值余额的自动同步，也不是把原账本清零。原 state.json 的累计保守计账 946,675、余额 53,325 及全部历史保持不变。

新增池由 config/eval-confirmation-budget-policy.json 声明，使用独立 ledgerId 和预算分支中的 confirmation-20261116.json。确认目的才能选此池；周期诊断被明确固定为 diagnostic，继续使用原池，不能借用新增确认额度。额度检查、原子执行锁、请求前预留、未知计费保护和条件写回均沿用同一套实现。

新一轮完整执行原定两题、两组、每组两次，共 8 次。模型为 deepseek-flash，profile 为 native-product，使用 Harbor 和独立无网络 verifier；种子 1701，主指标与阈值不变。旧轮次的预算截断记录继续保留，不混入新轮主分析。完成 8 次后关闭新增池的自动使用权限，即使结论不支持收益也不为追逐显著性加跑。

运行前通过配置端点的 /models 元数据校验所选模型，查询不生成 tokens，元数据哈希记入来源记录。实际请求和响应模型标识继续归档。完整执行实验可能得到收益不支持或证据不足，这与预算导致未完成分别报告；人审仍保持待完成，不自动批准发布。

统计预检在新数据采集前补齐了部分边界组的保护：任一任务/组全对或全错时，固定题集使用已有 Hoeffding 联合保守界限，总体推断不提供边界下的伪精确区间。原 8 次计划、主指标及收益阈值不变；合成反例与修订记录一并保留。
