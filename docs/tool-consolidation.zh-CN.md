# 工具面收敛：32 个工具怎么减、减到什么程度

> **状态：已落地（L1 + L2 + L3 全部实施）** ｜ 日期：2026-11-18
> 复现与回归守卫：`node scripts/tools/tool-consolidation-measure.cjs`
> （脚本从真实装配路径盘点：`toolkit` + `SubagentManager.register` + `registry.toOpenAiTools`，
> token 口径与请求体一致；现在它是**守卫**，把下面这些数字与不变量钉成可执行判据）

## 0. 落地结果（一句话）

**内置工具 32 → 20，全开装配 42 → 23**；旧名全部保留为**别名**（不进 schema），
安全语义下沉到 `kind`（`descriptor.byKind`），未登记 kind 一律 fail-closed。

| 装配 | 收敛前 | 收敛后 | schema |
|------|--------|--------|--------|
| 默认（rag 开 / 联网关 / 无子代理） | 32 | **20** | 7,599 → **6,488** tokens |
| + 联网 + Dify | 34 | **20**（web 是族，fetch 常驻） | 7,856 → 6,488 |
| + 子代理（8 个工具） | 42 | **23**（3 个族） | 10,151 → **8,260** |

| 任务面（agent.tool_profile=auto） | 收敛前 | 收敛后 |
|------|--------|--------|
| core | 12 / 2,677 | 13 / 3,573 |
| core+code（默认代码任务） | 17 / 3,435 | 16 / **4,197** |
| core+code+canvas | 24 / 5,753 | 19 / **6,295** |
| core+code+symbols | 21 / 4,297 | 17 / **4,560** |
| core+code+orchestration | 26 / 5,996 | 18 / **5,477** |

> 任务面**没有**全面变小，这点必须如实说明：工具数少了，但 `retrieve_context` 吸收了
> `query_scalars` 的 `keys/prefix/max`、`workbench_edit` 吸收了 6 个 kind，
> 单个工具的 schema 变贵了。真正的收益在**全量注册表**（默认装配 −15%、全开 −19% schema，
> 工具数 −38% / −45%）与「同一能力只有一份 schema 下发」。
> 想继续压任务面：走 `agent.tool_profile` 收紧（见 §7），不要靠继续合并 —— 边际收益已经很低。

---

## 1. 先把「32」说清楚：工具数不是常数（收敛前的口径）

工具数随装配变化，这也是当初「32」「34」「42」三个数字同时存在的原因
（`token-overhead-test.cjs` 里写的就是 34/40）：

| 装配 | 工具数 | 全量 schema |
|------|--------|-------------|
| **默认**：rag 开 / 联网关 / 未装配子代理 | **32** | 7,599 tokens |
| 再开联网 + Dify | 34 | 7,856 tokens |
| 再装配子代理（8 个 `delegate_*` / `subagent_*`） | 42 | 10,151 tokens |
| `discover_tools`（裁剪入口） | +1（仅 `tool_profile≠off` 时注册） | +51 tokens |

默认 32 个的完整清单（**收敛前**的注册顺序，保留作为对照）：

```
画布  get_workbench_model · workbench_edit · save_project · bulk_edit · ui_control · write_analysis_md
项目  scan_project · project_info · analyze_project · code_review
读取  read_file · find_files · search_files · list_directory · find_definition
      find_references · get_callers · get_callees · view_image
写入  write_file · edit_file · execute_shell · poll_job
检索  retrieve_context · query_scalars
记忆  remember · recall
交互  ask_user · update_plan · read_skill
其它  fetch_url · worktree
```

**收敛后**的 20 个（`registry.listTools()` 现在的实际顺序）：

```
画布  get_workbench_model · workbench_edit
项目  scan_project · project_overview
读取  read_file · list_files · search_files · symbol_nav · view_image
写入  write_file · edit_file · execute_shell · poll_job
检索  retrieve_context
记忆  memory
交互  ask_user · update_plan · read_skill
其它  web · worktree
```

**关键认识**：schema 总量不是「工具数的线性函数」。最贵的 3 个工具
（`workbench_edit` 1,060、`delegate_task` 823、`retrieve_context` 525 tokens）就占全开状态的 24%。
所以「砍数量」和「砍 token」要分开算账 —— 下面分三级，分别对这两件事负责。

---

## 2. 减少工具的四种方法（按 收益/风险 排序）

| 方法 | 做法 | 治的是 | 落地情况 |
|------|------|--------|----------|
| **M1 删冗余皮** | 同一动作的第二张工具皮直接删，动作并进已有工具 | 注册数量 | **已完成（L1）**：8 个冗余名吸收进 `workbench_edit` / `get_workbench_model` / `retrieve_context` / `project_overview` |
| **M2 同构族合并** | 参数一样、只有枚举不同的工具合成一个 `kind` 路由工具 | 注册数量 **+ schema 总量** | **已完成（L2 + L3）**：`symbol_nav` / `list_files` / `project_overview` / `memory` / `web` / `delegate` / `subagent_read` / `subagent_control` |
| **M3 任务面裁剪** | 按任务只下发子集，其余用 `discover_tools` 取回 | 每轮 token | **保留并已同步**（`tools/profiles.cjs` 换成新工具名，效果见 §4） |
| **M4 能力下沉** | 一次性能力（工作树、UI 操控、静态审查）做成 skill 或宿主命令，不进注册表 | 注册数量（完全不占上下文） | 部分具备（`read_skill` 已存在）；`worktree` 仍未下沉，留作后续 |

**实际执行**：M1 → M2 →（L3 子代理族），M3 保持不动。
M1 收益确定、风险最低；M2 是 token 收益最大的一级；M3 已经在起作用，不该被「合并」破坏。

---

## 3. 建议方案：三级，可独立发布、独立回滚

### L1 —— 删掉「同一动作的第二张皮」：默认装配 32 → 25（工具 −22%，schema 7,599 → 5,874，−23%）

| 删掉 / 改名 | 并进 | 为什么判定是冗余 |
|------|------|------------------|
| `bulk_edit`（277 tok） | `workbench_edit` 的 `kind=bulk_create/bulk_delete` | `workbench_edit.create` 已支持 `count`（上限 50）与批量 `operations`；`bulk_edit` 只是换个入口（多一个 create_files） |
| `write_analysis_md`（208） | `workbench_edit` 的 `kind=write_analysis` | 它就是「建 file 节点 + 写 `analysis/*.md`」两步的封装 |
| `save_project`（47） | `workbench_edit` 的 `kind=save_project` | 只有一个动作的工具，47 tokens 的 schema 单独占一个名字不划算 |
| `query_scalars`（264） | `retrieve_context` 的 `mode=scalar` / `keys` / `prefix` | **共享同一实现**：`retrieveContextTool` 里已有 `scalar` 模式、`keys` 精确查、标量路由；两者安全签名完全一致（只读、无审批、`workspace.read`） |
| `ui_control`（297） | `get_workbench_model`（`view=focus/zoom/pan`）+ `workbench_edit`（`kind=create`） | 7 个 action 里 6 个是「视图定位」；`new_content` 与 `workbench_edit.create` 重复 |
| `code_review`（130）+ `analyze_project`（226），并把 `project_info` 改名 | `project_overview`（`kind=info/structure/review`） | 三者签名完全同构（只读 / run 缓存 / `workspace.read`），作用都是「项目速览」 |

合计**消失 8 个工具名、新增 1 个（`project_overview`）** → 32 − 8 + 1 = **25**，净减 7。

**这一级的关键优势**：被吸收的 5 个工具动作并入的是**已有工具名**（`workbench_edit`、
`get_workbench_model`、`retrieve_context`），只有 `project_overview` 一个改名。
项目里有 25 张**按工具名**索引的语义表
（`descriptor.cjs` 的 `READ_ONLY/CACHEABLE/MUTATION/SCALAR_BACKED/CAPABILITY/SELF_TIMED`、
`sideEffects.cjs`、`observationState.cjs`、`leases.cjs`、`fileChanges.cjs`、`subagentEnvelope.cjs`、
`noProgressGuard.cjs`、`toolResultArchive.cjs`、`agentSettings.cjs` 的 `ordinaryWriteTools`）——
它们对 `workbench_edit` / `get_workbench_model` / `retrieve_context` 的判定**原样有效**，
但 `save_project` 的 `requiresConfirmation='WRITE'`、`query_scalars` 的 `readOnly`
必须由 `kind` 承接（见 §5 规则 1）。

### L2 —— 同构族合并：默认装配 25 → 20（tool schema 5,874 → 5,004，−15%；画布/符号面 −25%~−33%）

判据：**参数同构 + 安全签名同构**才合并。逐族实测核对结果：

| 新工具 | 成员 | 安全签名（readOnly \| mutates \| capability \| confirm \| sideEffect） | schema 变化 |
|--------|------|----------------------------------------------------------------|-------------|
| `symbol_nav` | `find_definition` `find_references` `get_callers` `get_callees` | **4 个完全同构**：`1\|0\|workspace.read\|-` \| read | 865 → 184（**−681**） |
| `list_files` | `find_files` `list_directory` | 同构：`1\|0\|workspace.read\|-` \| read（run 缓存） | 305 → 159（−146） |
| `project_overview` | `project_info` `analyze_project` `code_review` | 同构：`1\|0\|workspace.read\|-` \| read | 469 → 159（−310） |
| `memory` | `remember` `recall` | **异构**（写 vs 读）→ 需 kind 级安全门 | 331 → 192（−139） |
| `web` | `fetch_url` `web_search` `dify_call` | **异构**（`dify_call` 有 `HIGH` 审批）→ 需 kind 级安全门 | 344 → 168（−176） |
| `retrieve_context` | `retrieve_context` `query_scalars`（L1 已吸收） | **同构**：`1\|0\|workspace.read\|-` \| read | 789 → 530（−259） |

**`scan_project` 故意排除在外**（这是本方案最重要的一条否定结论）：
它的签名是 `readOnly=1` 但 `mutatesWorkspace=1 / capability=workspace.write`
（因为 `applyToWorkbench=true` 会写画布）。把它并入 `project_overview`，要么让只读角色拿到写能力，
要么让 `kind=info` 也要求写权限 —— **省 434 tokens 不值得破坏只读保护**。
正确顺序是：先把 `applyToWorkbench` 从 `scan_project` 移出（交给 `workbench_edit` 的
`kind=import_tree`），`scan_project` 变成纯只读之后再考虑并入。

### L3 —— 子代理 8 个 → 3 个（只影响装配了子代理的场景：全开装配 28 → 23，schema −15% / 累计 −38%）

| 新工具 | 成员 | 注意 |
|--------|------|------|
| `delegate` | `delegate_task` `delegate_tasks` | **同构**，可直接合并（1,095 → 561，−534） |
| `subagent_read` | `get_subagent_task` `inspect_subagent_retry` `merge_subagent_results` | 3 种签名；`merge` 的 capability 现写成 `shell.execute`（现成的脏数据，合并时顺手修正） |
| `subagent_control` | `cancel_subagent_task` `retry_subagent_task` `review_subagent_result` | 3 种签名，`retry`/`review` 有真实副作用 → 必须走 kind 级安全门 |

---

## 4. 合并后实测数据

**全量注册表**（三种装配各自独立，用同一 token 口径；L3 只在装配了子代理时才有意义）：

```
默认装配  32 → L1 25 / 5,874 tok → L2 20 / 5,004 tok            （工具 −22% / −38%，schema −23% / −34%）
联网装配  34 → L1 27 / 6,132 tok → L2 20 / 5,098 tok            （工具 −21% / −41%，schema −22% / −35%）
全开装配  42 → L1 35 / 8,432 tok → L2 28 / 7,398 tok → L3 23 / 6,285 tok
                                                                 （工具 −17%/−33%/−45%，schema −17%/−27%/−38%）
```

> 这几行是**收敛过程中的预测**（每一步模拟上线后的注册表）。最终真实值是
> `default 20 / 6,488 tok`、`full 23 / 8,260 tok` —— 比预测略贵，原因写在 §0 的注里：
> `retrieve_context` 与 `workbench_edit` 的属性并集把单个工具的 schema 撑大了。

**但真正影响用户的是「任务面」，不是全量注册表**（`agent.tool_profile=auto` 默认只下发一个子集）。
下表是**收敛后的真实测量**（现状列 = 收敛前，取自同一装配；数字可用守卫脚本复现）：

| 任务面 | 收敛前 | 收敛后 | 变化 |
|--------|--------|--------|------|
| core | 12 / 2,677 | 13 / 3,573 | **+33%**（core 收了 memory 族 + list_files 族） |
| **core+code（默认代码任务）** | 17 / 3,435 | 16 / 4,197 | 工具 −1，token **+22%** |
| **canvas（画布任务）** | 24 / 5,753 | 19 / 6,295 | 工具 **−5**，token +9% |
| research（调研任务） | 22 / 4,410 | 18 / 5,192 | 工具 **−4**，token +18% |
| **symbols（符号导航任务）** | 21 / 4,297 | 17 / 4,560 | 工具 **−4**，token +6% |
| orchestration（编排任务） | 26 / 5,996 | 18 / 5,477 | 工具 **−8**，token **−9%** |

**必须如实说清结论**：工具数全面下降（−1 ~ −8），但**大多数任务面的 schema token 反而上升**。
原因不是合并失败，而是合并把「多份互相重叠的 schema」换成了「一份更大的并集 schema」，
同时 core 面为了守住规则点名的能力（memory / list_files）而变宽。
真正的收益在**注册表规模与全量下发成本**（−15% / −19%），以及「同一能力不再各带一份」。

想继续压任务面应该走**裁剪**（`agent.tool_profile` / `discover_tools`），而不是继续合并：
`symbols` / `research` / `orchestration` 本来就只在需要时暴露，合并它们的边际 token 收益已经很低。

---

## 5. 合并必须遵守的三条硬规则

合并会把「一个工具 = 一种安全语义」变成「一个工具 = N 种安全语义」，而下列机制**全部按工具名**判定：

1. **安全门必须下沉到 `kind`（最关键）**
   `registry.execute` 的只读门、审批门、租约门、幂等账本都读 `descriptor`。
   若把 `remember`(写) 与 `recall`(读) 并成 `memory`，这个 descriptor 只能有一个 `readOnly` ——
   **只读角色会因此拿到写能力**（fail-open）。要求：
   - `descriptor` 增加 `byKind` 表，执行时用 `byKind[args.kind]` 覆盖
     `readOnly / mutatesWorkspace / requiredCapability / requiresConfirmation / cachePolicy`；
   - 未登记的 kind → **fail-closed**（按最保守取值）；
   - `sideEffects.classify(name)` 改成 `classify(name, args)`（现在它只看名字）；
   - `leases.resourceKeysFor` 已经接受 `args`，可直接用；
   - 输出契约（`builtInOutputSchemas.cjs`）也要按 kind 分支。

2. **旧名保留为别名（至少一个版本周期）**
   会被打破的引用面：`roles.cjs` 每个角色的工具白名单（5~14 个名字）、`profiles.cjs` 的
   `PROFILE_TOOLS`、**69 个测试文件**直接按名调用/断言、模型历史消息里的
   `update_plan.ownerTaskId`、run 事件（`tool_face` / `tools_trace.jsonl`）。
   做法：注册表提供 `registerAlias(legacyName, {family, kind})`，
   `execute` 时把别名翻译成 `(family, kind, args)`；**下发 schema 只下发新名**
   （旧名不占上下文）。这样调用侧零改动，上下文照省。

3. **kind 必须能被模型判别**
   合并把「选工具」变成「选 kind」。要求：`kind` 有 `enum` 且描述写清「什么时候用哪个」；
   同一 kind 名在不同族里不许语义不同；合并后的 schema **除 `kind` 外不设必填**，
   否则模型会为了凑必填选错 kind（这也是为什么实测合并后 schema 会明显小于「成员 schema 之和」）。

---

## 6. 不建议合并的部分（以及理由）

| 候选 | 为什么不合并 |
|------|--------------|
| `update_plan`（467 tok） | schema 大，但承载「稳定 id + 验收标准 + evidenceCallIds + dependsOn + ownerTaskId」契约，与任何族都不同构。要省只能**压 schema**，不能合并 |
| `worktree`（267） | 与 `subagent_task` 的 `isolation=worktree` 语义重叠。既然派子代理已能要隔离工作树，独立工具应**下沉成 skill**（M4），而不是合并 |
| `execute_shell`（365） | 安全语义最独特（argv/shell 双模式 + 程序白名单 + 审批），任何合并都削弱门 |
| `ask_user`（111） | 系统提示规则 16 已要求「用自然语言提问，不调 ask_user」。要么按规则**移除**，要么保留为独立交互原语 —— 不适合塞进任何族 |
| `read_file` / `write_file` / `edit_file` | 调用量占绝对多数（`read_file` 在 96 个文件里被引用），拆合都会伤 25 张语义表与全部用例 |
| `poll_job` | 与 `execute_shell` 是「启动 / 轮询」两段式，合并会让 execute_shell 的 schema 更贵 |

**另外两笔「不砍工具也能省」的收益**（优先级应高于继续合并）：

- `workbench_edit` 的属性表是**所有 action 的并集**（22 个属性、1,060 tokens），单次调用只用 3~4 个。
  收敛成 `operations: [{action, ...}]` + 每 action 只保留自己的必填，可压到 ~600（**−40%**）。
  这比再合并一个工具的单笔收益都大。
- `update_plan` 的 `items[].*` 嵌套 schema（467 tokens）同理可压到 ~250。

---

## 7. 实施记录与验收

| 步骤 | 动作 | 状态 | 实际结果 |
|------|------|------|----------|
| 0 | `descriptor.byKind` + `effectiveDescriptor` + `registry.registerAlias`（**不动任何工具**） | **已完成** | 未登记 kind fail-closed；`kindField`/`defaultKind` 支持 `view`/`action` 判别字段 |
| 1 | L1：8 个名字吸收进 4 个已有工具 | **已完成** | 32 → 25；旧名全部可用（19 个别名） |
| 2 | L2：`symbol_nav` / `list_files` / `project_overview` / `memory` / `web` | **已完成** | 25 → 20 |
| 3 | L3：子代理 8 → 3（`delegate` / `subagent_read` / `subagent_control`） | **已完成** | 42 → 23（舞台注册表复用执行体，零执行逻辑改动） |
| 4 | 同步按名索引表（roles / profiles / observationState / leases / fileChanges / sideEffects / agentSettings / benchmarkProfile / workspaceCache / noProgressGuard / toolResultArchive） | **已完成** | 族工具按 kind 分流；旧名沿别名解析 |
| 5 | 提示词同步（`TOOL_GUIDE` / 运行时规则 4/7/8/12/13 / 子代理 roleSkills） | **已完成** | 规则点名的工具都在暴露面里 |
| 6 | 棘轮与用例同步（`token-overhead` / `tool-descriptor` / `builtin-output-contract` / `symbol-navigation` / `subagent-*` …） | **已完成** | 核心套件 195 个用例：**191 通过**；4 个失败为环境/既有问题（见下） |
| 7 | `scan_project` 去 `applyToWorkbench` 后再并入 `project_overview` | **未做**（刻意） | 它仍是「只读但会写画布」的异构体，强并会破坏只读保护 |
| 8 | `worktree` 下沉为 skill（M4） | **未做** | 编排面继续带 1 个工具 |

**已知的 4 个失败（与本次收敛无关，收敛前同样失败）**：
`coding-grader-test`（Windows 符号链接 EPERM）、`eval-docker-test`（本机无 Docker）、
`selection-test`（需要 Electron 运行时的 `whenReady`）、`compaction-test`（摘要调用断言，
在未改动的 `agent.cjs` 上同样失败）。

**回归守卫**（随时可跑，判据已固化）：
`node scripts/tools/tool-consolidation-measure.cjs` —— 存量数量、任务面成本、
每个族的 kind 表与 fail-closed、26 个旧名别名的存在与「不占 schema」。

---

## 8. 一句话结论

工具不该一股脑砍，而应分三层：

1. **先删掉同一动作的第二张皮**（默认装配 32 → 25；8 个名字消失，动作并入
   `workbench_edit` / `get_workbench_model` / `retrieve_context` 三个**已有工具名**，
   只有 `project_info` → `project_overview` 换了名字）；
2. **再把 5 个同构族压成 `kind` 路由**（25 → 20）；
3. **最后把子代理 8 个收敛成 3 个**（全开装配 42 → 23）。

真正让方案能安全落地的不是「合并」本身，而是配套的两件基础设施：
**① 安全门下沉到 `kind`**（`byKind` + fail-closed + `confirmationEnforced` 同步）、
**② 旧名别名**（`registerAlias`，含 `tools.allowed/deny`、审批免打扰规则、角色白名单与
按名索引的 25 张语义表的兼容）。没有这两件，合并会**静默改写只读/审批语义** ——
这次落地过程中就真实踩到过三个：`aliasedFrom` 写进 data 破坏闭合契约、
kind 级确认没有同步 `confirmationEnforced`（视口动作直接免审批）、
以及「门问一遍 + 函数内再问一遍」的双弹窗。

一句话：**合并的难点不在「少几个工具」，而在「一个名字承载多种安全语义」时，
每一道门（只读门 / 审批门 / 租约门 / 幂等账本 / 缓存保活 / 副作用分类 / 资源键）
都必须能按 kind 分流，且旧名还能落到同一条路径上。**
