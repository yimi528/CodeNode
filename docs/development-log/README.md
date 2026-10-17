# CodeNode 开发日志

这里按完整自然日保存 CodeNode 的开发记录，作为提交记录之外的可读变更历史。

## 目录规则

- 每天一个文件：`YYYY-MM-DD.md`。
- 每次开发追加一个时间精确到秒的条目：`## YYYY-MM-DD HH:mm:ss CST`。
- 时间统一使用 `Asia/Shanghai`。
- 每个条目必须包含以下三节：
  - `### 修复的 Bug`
  - `### 更新内容`
  - `### 验证结果`
- 没有 Bug 修复或没有功能更新时填写“无”，不要删除标题。
- 只追加已经发生且可以验证的事实，不写计划中的工作，不覆盖当天已有条目。

## 快速创建记录

```bash
npm run log:add -- --type fix --summary "修复最近项目不显示" \
  --details "将最近项目记录移到主进程持久化存储" \
  --verification "npm run test:recent-projects"
```

`--type` 可用值为 `fix`、`feature`、`refactor`、`docs`、`chore`。命令会创建当天文件，或在文件末尾追加新条目。

提交前运行：

```bash
npm run test:development-log
```

该检查会验证文件名、完整时间和必填章节；在工作区存在其他开发改动时，还会检查当天日志是否同步更新。CI 中则检查当前提交是否同时包含开发日志。
