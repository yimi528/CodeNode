# CodeNode 公共 Benchmark 接入

通过固定版本 **Harbor 0.25.0** 运行任务环境和独立 verifier，实际执行器是容器内的 `bin/codenode-agent.cjs`。本接入保留 CodeNode 原生 Agent 循环、提示词、文件工具和终端工具，不使用其他 Agent 代替 CodeNode 解题。

## 安装与检查

需要 Python 3.12+、Node 22.12+、可用的 Docker，以及项目已执行 `npm ci`。下面使用 uv 按锁文件安装；没有 uv 时也可用 Python 的 venv/pip 安装此包，但依赖锁的复现应使用 uv。

```sh
uv sync --project benchmarks --locked
npm run benchmark:doctor
```

npm 入口优先使用 `benchmarks/.venv`。已有其他虚拟环境时，可以用 `CODENODE_BENCHMARK_PYTHON=/absolute/path/to/python` 指定。`doctor` 只显示依赖、Docker 和凭据是否存在，不打印密钥。

首次运行会创建一个只含运行源码、公共配置 schema 和必要 TypeScript 依赖的快照。快照排除 `.git`、本机 `agent.properties`、个人 soul、记忆、项目历史、评测脚本和答案。每批任务使用同一份快照，记录源码 SHA-256、快照归档 SHA-256、CodeNode/Harbor/Node 版本与预算。

## SWE-bench Verified

默认使用 Harbor 官方适配的 `swebench-verified@1.0`，源仓库在 `/testbed`。先跑少量任务验证环境与模型设置：

```sh
# 在环境中设置 CODENODE_API_KEY；不要把真实密钥写入配置或命令历史。
npm run benchmark:swebench -- \
  --model openai/MODEL_ID \
  --base-url https://YOUR_ENDPOINT/v1 \
  --limit 5 --workers 1
```

模型接入目前声明支持 OpenAI Chat Completions 兼容格式。`--model` 使用 Harbor 的 `provider/model` 名称；原生 Anthropic/Gemini 格式暂未在此适配器声明支持。如通过兼容网关调用这些模型，应按网关的 OpenAI 兼容模型 ID 配置。

当前固定版本的 SWE 任务引用 x86_64 镜像。在 Apple Silicon 等 ARM 主机上运行时，为本次命令设置 `DOCKER_DEFAULT_PLATFORM=linux/amd64`，并确保 Docker 支持模拟执行；否则构建会报 `no match for platform in manifest`。例如：

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 npm run benchmark:swebench -- \
  --model openai/MODEL_ID --base-url https://YOUR_ENDPOINT/v1 \
  --limit 5 --workers 1
```

如果 Docker 构建在 `auth.docker.io` 连接超时，可检查宿主 CLI 的代理环境变量。系统代理可用时，仅为评测命令设置相应 `HTTPS_PROXY` / `HTTP_PROXY`，无需修改 Docker 全局设置。镜像拉取失败属于基础设施异常，不能作为模型解题分数。

可以用 `--task 'sympy__sympy-*'` 过滤任务，或通过 `--tasks /absolute/path/to/official/tasks` 使用预先下载的官方 Harbor 任务目录。未提供模型凭据会非零退出，不会悄悄改用脚本化模型。

评分来自 Harbor 的 SWE 适配器 verifier（其使用 SWE-bench 的测试与 grading 逻辑），并非 CodeNode 的自动校验。SWE 模式另外保存 `prediction.patch`，包含新增文件。导出官方预测格式：

```sh
npm run benchmark:export-swe -- \
  --jobs out/benchmarks/run-RUN_ID \
  --output out/benchmarks/predictions.jsonl \
  --model CodeNode-MODEL_ID
```

每行包含 `instance_id`、`model_name_or_path`、`model_patch`。失败且无补丁的任务保留空预测，避免从评测集合中消失；多次尝试同一道题时拒绝自动挑选“最好”的结果。

需要与官方 SWE-bench 主 harness 复核时，可在单独环境安装官方 `swebench`，使用当前官方 v5 CLI：

```sh
swebench eval verified -p out/benchmarks/predictions.jsonl \
  --run-id codenode-UNIQUE_RUN_ID -j 1
```

每批不同补丁使用新的 run-id，避免命中旧评分缓存。ARM 主机可能需要按官方说明提供 task repo 来本地构建镜像。Harbor 适配器评分和主 harness 复核应分别标注；未实际复核时不宣称二者分数完全等同。

## Terminal-Bench

默认固定为官方 **Terminal-Bench 2.1 的 Hub revision 6**：`terminal-bench/terminal-bench-2-1@6`，不是旧榜单中的 2.0。需要对照旧版本时显式传 `--dataset terminal-bench@2.0`，不要混合比较版本。

```sh
npm run benchmark:terminal -- \
  --model openai/MODEL_ID \
  --base-url https://YOUR_ENDPOINT/v1 \
  --limit 5 --workers 1
```

Terminal 任务可能操作多个绝对路径，因此 CodeNode 的项目根为容器 `/`，任务的原工作目录会写入提示。隔离由 Harbor 的任务容器和网络策略提供；这个专用 profile 不用于宿主机执行。模型的工具子进程仍使用现有凭据环境过滤。

若环境已有 Node 22.12+ 则使用它；否则 setup 下载固定的 Linux Node 22.23.1，并核对官方 SHA-256 后上传。也可直接使用 Harbor 的 `--ak node_archive_path=... --ak node_sha256=...` 提供离线运行时。当前支持 Linux x64/arm64。

## 结果和预算

默认每批最多 5 题、并发 1、每题尝试 1 次、基础设施重试 0 次。CodeNode 模型循环上限为 60，单次请求超时 120 秒；题目自己的 Harbor 总时限和 verifier 时限继续生效。可以用 `--max-iterations`、`--turn-timeout`、`--limit`、`--workers` 显式调整。

原生总 Token、总工具调用等预算同样生效，实际值保存在每题原生日志的 `benchmark_context.profile.limits` 中；尚未达到 60 轮也可能因其他预算结束。Harbor 会在原生 CLI 非零退出后继续尝试独立评分，因此预算耗尽的任务仍可能得到 reward 1；运行异常和解题得分分别统计。

输出位于 `out/benchmarks`：

- `snapshot-*/runtime.tar.gz` 和 `manifest.json`：本次冻结的执行器、参数及来源指纹。
- `run-*/config.json`、每题 `result.json` 与 verifier 日志：Harbor 的配置和独立评分事实。
- 每题 `agent/codenode.jsonl`、`trajectory.json`：原生日志与通过 Harbor 模型校验的 ATIF 轨迹。
- `snapshot-*/summary.json`：按本次 run 单独汇总，未评分和异常仍进入总数；缺失 reward 按 0 计入均值，同时单列错误和未评分数。

Harbor 进程退出 0 不代表任务通过。本入口读取逐题 reward 和异常；存在未解决、未评分、异常或没有实际任务结果时返回非零。运行成功也不意味着得到了完整 500 题或整个 Terminal-Bench 的分数；报告必须注明实际任务列表、版本、模型、预算和重复次数。

## 接入验证

### 固定题目、同模型对照

`benchmark:compare` 使用已完成的本地报告固定原始题目与 CodeNode 快照，与 Harbor 0.25.0 的 Terminus-2 参考 Agent 做成对实验。每题交替安排两组先后顺序，单次尝试、串行执行，统一 300 秒请求时限、60 轮、600000 Token 预算。参考 Agent 保留原生提示词、终端反馈、JSON 解析和压缩流程，外层只增加预算、计账和补丁收集；其文本 Token 预留与 CodeNode 原生算法一致。

```sh
npm run benchmark:compare -- prepare \
  --previous-report out/benchmarks/report-RUN_ID.json \
  --output out/benchmarks/comparison-UNIQUE_ID
npm run benchmark:compare -- warm --plan out/benchmarks/comparison-UNIQUE_ID/plan.json
# 在环境中提供模型凭据，再运行；不要把 Key 放入参数或报告。
npm run benchmark:compare -- run --plan out/benchmarks/comparison-UNIQUE_ID/plan.json
npm run benchmark:compare -- report --plan out/benchmarks/comparison-UNIQUE_ID/plan.json
```

`prepare` 固定镜像 digest、题目校验和、预算与轮次顺序；`warm` 只预装公开评分依赖和终端运行工具，不复制测试内容或参考补丁。两组使用相同预热镜像，测试原文和官方评分时限不变。需要构建代理时可在 `prepare` 显式提供 `--build-proxy`，其地址必须可从 Docker 容器访问；不修改机器全局代理。

本轮事先确认的 astropy 测试 ID 判分异常单列，原始 reward 保留，另报排除该异常题的有效题目统计。未评分仍进入全部题目分母，不会被当作配对胜利。预热同时改变初始环境，因此新旧轮次差异不能只归因于请求时限。CodeNode 工具调用与 Terminus 终端命令是不同动作单位，100 次动作上限只用于控制运行；主要按相同 Token 与时间预算比较。

`run` 可跳过已有逐题结果继续执行，不会覆盖旧尝试；不完整任务需要先核查。输出为 `comparison-report.md`、`comparison-results.json` 以及每题原始 Harbor 记录。适配代码、原生归档或预热镜像改变后会拒绝继续混跑。

Terminus-2 的说明见 [Harbor 官方参考 Agent 文档](https://harborframework.com/docs/agents/terminus-2)。本地接入验证命令为 `npm run test:benchmark-comparison-smoke`，使用脚本模型，不产生真实 Benchmark 成绩。

```sh
npm run test:benchmark-profile
npm run test:benchmark-adapter
npm run test:benchmark-smoke
npm run test:benchmark-smoke -- --negative
npm run test:benchmark-smoke -- --swe
```

Python 单测直接使用固定 Harbor 的 API 和 ATIF 模型。Docker smoke 使用本地脚本模型和自建微型题目，验证原生 CLI、真实工具写盘、官方 Harbor verifier 的 1/0 分、SWE 新文件补丁和预测导出；它们是接入测试，不能当作公共题集成绩。两项 smoke 都从 `node:22-alpine` 独立构建环境，不依赖开发机自定义镜像；镜像构建需要能安装 Bash/Git。

## 原生功能 A/B 与中断恢复

`benchmark:ab` 在同一份冻结运行时中比较六组功能开关的关闭／开启版本。沿用原固定题目、模型、镜像和预算，排除运行前已确认的判分异常题；每题每组首次尝试、并发 1、交替执行顺序。它是已见题目的诊断回归，不是留出集泛化成绩。是否默认推广按验证结果决定，功能实现不等于已证明收益。

```sh
npm run benchmark:ab -- prepare --previous-plan out/benchmarks/comparison-RUN_ID/plan.json --output out/benchmarks/native-ab-UNIQUE_ID
# 用环境变量提供凭据，凭据不写入计划或运行时。
npm run benchmark:ab -- run --plan out/benchmarks/native-ab-UNIQUE_ID/plan.json
npm run benchmark:ab -- report --plan out/benchmarks/native-ab-UNIQUE_ID/plan.json
```

计划冻结原生归档、适配器、题目和预热镜像指纹；每次启动前重查。任务阶段原子写入 `states/`，同一输出目录由进程锁保护；发现已有任务或不明确的启动状态时只读取产物，不自动再次付费推理。解题结束前可保存 Docker 文件系统快照和工具轨迹／补丁校验和，之后进入评分阶段。缺少足够产物或快照时保留中断状态并要求检查，不把未知尝试当成免费重跑。

对支持文件系统重放的 SWE 任务，可以从解题快照只恢复评分：

```sh
npm run benchmark:recover-grading -- --checkpoint PATH/agent/solve-checkpoint.json --task PATH/TO/ORIGINAL_TASK --output out/benchmarks/recovery-UNIQUE_ID
npm run test:benchmark-smoke -- --swe --checkpoint
```

恢复前核查原始代码产物、原测试／任务和解题镜像指纹，使用原评分时限及 CPU／内存约束；独立输出恢复结果，不修改原分数。恢复不调用模型。需要原进程状态的 Terminal 任务、需要额外 verifier 环境凭据的任务，以及缺失或不一致的检查点会明确拒绝不完整重放。解题快照保留为本机 Docker 镜像，不上传；日志中的评分依赖网络失败且没有测试执行证据时另记 `startup_failed`，即使原始 reward 为 0 也保留原值。

准备阶段的 DNS 失败可以使用 `benchmark:recover-setup` 生成独立恢复清单，再用 `--run` 执行。它要求原记录没有 Agent 执行时间、没有模型日志或用量，且失败类型属于安装网络错误；只补齐尚未发生的首次模型尝试，已有 Agent 不重跑。固定离线 Node 归档须提供已核对的 `--node-sha256`，原失败、恢复配置和新结果分别留存。

对已执行记录明确证明为 Python `http.server` 的静态服务，`benchmark:recover-static-service` 可从原镜像与记录参数重建服务，再运行未修改的原测试；不重放原 Agent shell 命令，不修改源代码，不调用模型。它不支持任意进程恢复，也不将新评分覆盖到原始成绩。离线评分依赖的使用单独记入恢复环境。

## 官方接口来源

- [Harbor 自定义 Agent](https://docs.harborframework.com/agents/custom-agents)：实现按固定 PyPI 版本验证，不能假设上游 main 的新生命周期钩子已包含在发布版中。
- [Harbor SWE-bench 适配器](https://github.com/harbor-framework/harbor/tree/main/adapters/swebench)：任务环境与评分来源。
- [Terminal-Bench 2.1 官方数据集](https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2-1/6)：固定版本来源。
- [SWE-bench 官方用法](https://github.com/SWE-bench/SWE-bench#-usage)：预测与独立复核入口。


## 统一评测控制器

编码任务导出、共享预算 broker、分离 verifier、持久证据、独立重评和发布检查已接入 `npm run eval:system`。入口、profile 差异、当前真实模型诊断和外部验收边界见[自动化评测运行与验收](../docs/agent-evaluation-operations.zh-CN.md)。`benchmarks/codenode_benchmarks/evaluation.py` 使用固定 Harbor SDK 校验任务配置；本机 Docker 不可用时不会将 SDK 单测当作容器实跑成绩。
