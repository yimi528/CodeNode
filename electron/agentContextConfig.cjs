'use strict';
const { configInteger, configNumber, configFlag } = require('./agentRuntimeConfig.cjs');

function parseContextConfig(cfg) {
  return {
    enabled: cfg['agent.context.trim'] == null ? true : String(cfg['agent.context.trim']).toLowerCase() !== 'false',
    archiveResults: configFlag(cfg, 'agent.context.archive_results', false),
    maxInputChars: configInteger(cfg, 'agent.context.max_input_chars', 250000, 20000, 4000000),
    // 最近这么多条消息永不裁（少而精：当前任务的最新结果几乎总是要用的）
    keepRecentMessages: configInteger(cfg, 'agent.context.keep_recent_messages', 12, 0, 200),
    // 小于这个长度的工具结果不裁：省不下多少，反而丢信息
    minResultChars: configInteger(cfg, 'agent.context.min_result_chars', 2000, 200, 100000),
    // 第二档（预算单靠「最近 N 条之外」还是压不住时）仍然保护最后几条：默认 1
    // —— 只保证「最后一条（通常是本轮最新的工具结果）+ system」永不被裁；再往上都属于可裁区，
    // 因为唯一的替代方案是整条请求被供应商拒掉（超窗），那对用户更糟。
    hardKeepRecentMessages: configInteger(cfg, 'agent.context.hard_keep_recent_messages', 1, 0, 50),
  };
}

function parseCompactionConfig(cfg) {
  return {
    enabled: cfg['agent.compact.enabled'] == null ? true : String(cfg['agent.compact.enabled']).toLowerCase() !== 'false',
    budgetAware: configFlag(cfg, 'agent.compact.budget_aware', false),
    // 触发线 = 有效窗口 × ratio。Codex 的取值：窗口 1,000,000 / model_auto_compact_token_limit=900,000
    ratio: configNumber(cfg, 'agent.compact.ratio', 0.9, 0.3, 1),
    // 有效窗口：0 = 用模型的 contextWindow（models.json）；没有时才用 fallback_window
    contextWindow: configInteger(cfg, 'agent.compact.context_window', 0, 0, 4000000),
    fallbackWindow: configInteger(cfg, 'agent.compact.fallback_window', 128000, 8000, 4000000),
    // 摘要输入上限：单项 / 总量（超出则从最旧开始丢并如实标注，避免「压缩请求自己超窗」）
    itemMaxChars: configInteger(cfg, 'agent.compact.item_max_chars', 6000, 500, 200000),
    inputMaxChars: configInteger(cfg, 'agent.compact.input_max_chars', 400000, 20000, 4000000),
    // Codex 行为：保留**人的轮次**，机器的注入提示不保留（实测它丢掉了 <codex_internal_context> 那类）
    keepUserTurns: cfg['agent.compact.keep_user_turns'] == null ? true : String(cfg['agent.compact.keep_user_turns']).toLowerCase() !== 'false',
    keepUserMaxChars: configInteger(cfg, 'agent.compact.keep_user_max_chars', 2000, 100, 100000),
    keepUserTotalChars: configInteger(cfg, 'agent.compact.keep_user_total_chars', 20000, 500, 500000),
    /**
     * P1-4：压缩后**逐字保留**的最近操作尾部（token）。0 = 不保留（回到旧行为）。
     * 审计给的量级是 8k~15k；出厂 12k。尾部按**原子操作组**整组取，绝不为凑预算切开一次工具调用。
     */
    tailTokens: configInteger(cfg, 'agent.compact.tail_tokens', 12000, 0, 15000),
    /**
     * 单个操作组超过尾部预算时是否仍然整组保留。默认 **true**（最新操作逐字优先）：
     * 真实场景里一个操作组经常就超过尾部预算，默认丢弃等于让这个能力几乎不生效。
     * 怕压不下来的话不必担心 —— 压缩环节在「压后仍在线下」时会用**严格预算**自动重算一次。
     */
    tailAllowOversized: cfg['agent.compact.tail_allow_oversized'] == null
      ? true
      : String(cfg['agent.compact.tail_allow_oversized']).toLowerCase() === 'true',
    /** P1-4 触发公式里的安全 buffer 与输入上限（0 = 不参与约束，行为与旧版一致） */
    bufferTokens: configInteger(cfg, 'agent.compact.buffer_tokens', 8000, 0, 200000),
    inputLimit: configInteger(cfg, 'agent.compact.input_limit', 0, 0, 4000000),
    // 硬裁剪一启动（占位符已经开始顶替正文）就顺手做语义压缩：占位符换不出质量
    onTrim: cfg['agent.compact.on_trim'] == null ? true : String(cfg['agent.compact.on_trim']).toLowerCase() !== 'false',
    /**
     * 供应商真报超窗（400）时「压一次 + 重发」的自救次数。只救一次是刻意的：
     * 压完还超说明剩下的东西本身超窗，硬重试只会烧钱。0 = 关掉自救（仅如实报错）。
     */
    overflowRecoveries: configInteger(cfg, 'agent.compact.overflow_recoveries', 1, 0, 3),
    // 摘要用哪个模型（留空跟随主模型）；摘要不需要思考链，默认关
    model: String(cfg['agent.compact.model'] || '').trim(),
    reasoning: /^(1|true|yes|on)$/i.test(String(cfg['agent.compact.reasoning'] || '')),
    maxOutputTokens: configInteger(cfg, 'agent.compact.max_output_tokens', 4096, 256, 32768),
    timeoutMs: configInteger(cfg, 'agent.compact.timeout_ms', 60000, 5000, 600000),
  };
}

module.exports = { parseContextConfig, parseCompactionConfig };
