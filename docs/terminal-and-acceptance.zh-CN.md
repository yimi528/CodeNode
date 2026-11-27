# 终端、任务目录与显式验收

## 终端契约

`execute_shell` 支持两种互斥形式：

```json
{"mode":"argv","program":"python3","args":["-c","import sys; print(sys.argv[1:])","","a b","|"],"cwd":"."}
```

argv 直接启动程序，保留空参数、空格和引号；`|`、`>`、`&&` 是普通参数。解释器代码按实际参数审计，日志展示用的转义字符串不作为唯一审计依据。桌面端继续执行白名单、审批、路径和网络规则。

```json
{"mode":"shell","command":"printf '%s\n' 'a b' | head -1 > result.txt && cat result.txt","cwd":"."}
```

shell 形式仅在显式评测容器入口启用，原文交给 `/bin/sh -c`；不拆词、不重拼、不启动登录 shell。评测容器中的旧 `{command}` 也采用此语义，程序范围由评测器的外部隔离承担。桌面端旧 `{command}` 保留既有程序执行方式，普通命令含未引用的 shell 运算符时明确拒绝；需要解释脚本时继续使用已有 cmd/powershell 入口。

`cwd` 只影响本次调用。前台、后台和输出分页结果记录 `executionMode`、`cwd`、`program`；进程正常退出且退出码非零仍可能是工具调用成功，不能据此判定测试通过。超时和取消按失败记录。

## 工程与访问边界

`projectRoot` 是任务工程及默认 cwd，相对文件路径也从这里解析。`accessRoot` 是独立的文件访问边界，默认与工程目录相同。只有评测入口允许通过 `--access-root` 扩大边界，并且工程必须位于边界内。

评测适配器使用题目初始 cwd 作为工程目录，原 `workspace` 参数作为访问边界。例如初始 cwd 为 `/app`、workspace 为 `/` 时，`write_file path=answer.txt` 写入 `/app/answer.txt`；明确的容器绝对路径仍可访问。默认搜索、配置和运行日志从工程目录开始，不遍历整个访问边界。

文件工具、读取缓存和写资源锁使用同一解析规则，校验真实路径、敏感文件与受保护授权路径。manifest/checkpoint 新增 `projectRoot`、`workingDirectory`、`accessRoot`、`logDirectory`；保留旧 `workspace` 字段及原有恢复规则。旧记录缺少新增字段时，沿用原 workspace 语义，不改写历史记录。

## 运行级验收契约

调用方显式传入 JSON；运行开始时复制规则、计算 SHA-256，并写入 `task_acceptance_contract` 运行事件。后续修改源 JSON 不会修改本次规则。harness 不从自然语言自动生成可执行检查，也不从隐藏评分读取检查条件。

```json
{
  "version": 1,
  "artifacts": [
    {"id": "required-output", "path": "answer.txt", "maxBytes": 2500}
  ],
  "checks": [
    {
      "id": "public-counterexample",
      "execution": {
        "mode": "argv",
        "program": "python3",
        "args": ["public_repro.py"],
        "timeoutSeconds": 60
      },
      "inputs": ["src", "public_repro.py", "requirements.txt"],
      "reproduce": {
        "exitCode": 1,
        "outputIncludes": "expected public counterexample"
      }
    }
  ]
}
```

`artifacts` 检查必需文件及可选的实际字节上限。`checks` 的最终退出码必须为 0；`inputs` 必填，声明需要版本校验的文件或目录，应包含被测源码、测试和相关依赖配置。报告只证明这个明确范围。省略 `reproduce` 时只运行最终检查；配置它时在模型修改前运行同一命令，要求非零退出码和指定错误标记匹配，完成前再要求退出码 0。环境错误不会自动被视为有效复现。

规则文件最多 64 KiB，最多 100 个产物、20 个命令。未知字段、重复 id、空规则和错误类型在运行前拒绝。默认每个命令超时 60 秒，可显式设为 1–600 秒。验收命令遵守相同的工具权限和审批，占用运行工具调用额度；验收次数沿用 `editing.maxVerificationRuns`（默认 3）。

版本校验读取实际内容哈希；单次最多遍历 10000 个输入条目、读取 64 MiB。默认跳过工程缓存和 `.codenode` 等内部目录。符号链接、无法完整读取、执行期间输入变化或交付前版本变化，不会得到有效通过结论。输出分页或截断会在证据中标明。

```sh
node bin/codenode-agent.cjs --project /path/to/project \
  --prompt-file task.txt --acceptance-file acceptance.json --json
```

命令检查仍需原有执行授权。可信嵌入调用方可将同一对象放入 `cfg.acceptance`；桌面用户也可通过下述「任务验收」面板配置相同契约。Harbor 运行入口支持 `--acceptance-file`，也可显式传入适配器参数 `acceptance_file`。仅为使用者自己选定、公开的任务配置规则，避免给一批不同任务误用同一验收文件。

## 桌面对话配置

普通模式的对话输入框上方提供折叠的「任务验收」面板，无需开启高级编排。

- 点击「使用项目测试」会读取当前项目 `package.json`，仅在确有 `scripts.test` 时选择 `npm` 与 `["test"]`；选择本身不执行命令。
- 可以手动填写程序及 JSON 参数数组，例如程序 `python3`、参数 `["public_repro.py"]`。桌面采用 argv，不解释管道与重定向；复杂逻辑请放进项目脚本。
- 验收输入范围按行声明源码、测试及依赖配置，用于证据指纹核对；它不是 Agent 的写入范围限制。必需产物按行填写文件路径，命令可以留空以仅检查产物。
- Bug 修复可勾选「要求修改前复现失败」，指定非零退出码与错误标记。普通功能与回归任务可以只做最终检查。
- 发送时复制并冻结本轮契约；运行中配置控件禁用。主进程再次验证结构和工程路径，拒绝越界与桌面 shell 契约。参数格式错误在界面提示并保留草稿。
- 配置属于当前对话输入；切换工程或对话时重置，不自动替新任务套用旧规则。续跑从原 Run 恢复冻结契约，拒绝换规则；修改前证据沿用原记录，不在已经修改的代码上重新制造反例，缺失证据保持未确认。
- 自研与外部 Agent 使用同一独立验收器；外部 Agent 自述完成但规则未通过时返回失败并保留改动。未配置时继续显示「需求尚未验收」，不将运行结束当作需求验收通过。

## 完成与报告

最终结果的 `taskAcceptance`、运行事件和交付卡独立展示任务验收。每条命令证据分别记录工具是否成功、进程退出码、命令、cwd、阶段及执行证据 ID；局部 `codeVerification` 与官方评分保持独立。

显式规则未通过时，Agent 和现有局部校验共享一次交付修正机会；仍未通过则返回 FAILED，保留文件并说明验收未通过。取消或额度耗尽时不追加验收修正请求。交付前重新核对输入，失效或未知证据不能作为通过依据。

未传契约时，报告为 `unconfigured` 并显示“未配置任务验收，需求尚未验收”；COMPLETED 只表示本轮运行正常结束。显式规则通过也只覆盖所选规则，不自动授予 Goal 独立验收通过。文件回滚后，交付卡将原验收证据标为失效。

## 本地验证入口

- `npm run test:terminal-contract`：argv、POSIX shell、cwd、访问边界、缓存、资源锁、后台和取消。
- `npm run test:desktop-acceptance`、`npm run test:desktop-acceptance-ui`：桌面配置、真实 IPC、反例与终态、续跑原契约、外部后端验收。
- `npm run test:task-acceptance`：产物、公开反例、证据版本、权限、额度和模拟模型完成拦截。
- `npm run test:headless`、`npm run test:delivery-ui`：CLI 退出状态、事件展示和回滚失效。
- `npm run test:benchmark-adapter`、`npm run test:benchmark-smoke`：适配器和本地模拟模型 Docker 链路。

这些回归不调用付费模型，也不证明真实任务通过率已提高。
