'use strict';

let chatCompletion;
let recordCost;
function configure(deps = {}) {
  if (typeof deps.chatCompletion !== 'function' || typeof deps.recordCost !== 'function') throw new Error('Agent compression dependencies are incomplete');
  chatCompletion = deps.chatCompletion;
  recordCost = deps.recordCost;
}

/**
 * 子代理压缩的系统提示：**常量**，独立上下文，只接收单份工具结果，不共享主对话。
 *
 * 为什么必须是常量：压缩请求由「固定前缀 + 变动的原文」组成，而服务端前缀缓存只能命中
 * 请求开头那一段 —— 把预算数字拼进 system 会让 system 随配置漂移、也让同一份原文的请求
 * 前缀不一致。现在长度预算作为 user 段末尾的一句提示，system 恒定（前缀可稳定命中）。
 */
const COMPRESSOR_SYSTEM_PROMPT =
  '你是一个「工具结果压缩代理」。你的输入是一份工具调用返回的原始结果（可能很大），\n' +
  '你的唯一任务是把它压缩成一份简洁、准确、可被主 Agent 直接使用的「关键信息摘要」。\n' +
  '硬性要求：\n' +
  '1. 必须保留所有继续推进任务所必需的事实：文件路径、行号引用、符号名/函数名/类名、关键字段值、错误信息、状态、数量统计、节点 id 与 label。\n' +
  '2. 所有 [path#Lx-Ly] 与 [source: ...] 引用必须原文保留，不得改写或省略，因为主 Agent 需要引用真实来源。\n' +
  '3. JSON/数据结果压缩为要点列表，删除重复冗余；不要逐行照抄。\n' +
  '4. 用中文、结构清晰（- 列表/小标题）；长度按调用方给出的字符上限控制，不要超过。\n' +
  '5. 只输出摘要本身，不要输出任何解释、前言或 `<tool_result>` 包裹。\n' +
  '6. 不得添加原始结果中不存在的信息，不得编造。';

/** 是否应对该工具结果做子代理压缩。 */
function shouldCompress(compression, toolName, contentLength, usedCalls) {
  if (!compression || compression.enabled === false) return false;
  if (compression.exclude && compression.exclude.includes(toolName)) return false;
  if (usedCalls >= compression.maxCalls) return false;
  return contentLength > compression.thresholdChars;
}

// 配置的最大迭代数只是停止上限，不能当成摘要一定会被复用的次数。
const MAX_COMPRESSION_FORECAST_ROUNDS = 2;
// 预留压缩器 system prompt、JSON 封装和分段标记的固定输入开销。
const COMPRESSION_ESTIMATED_FIXED_OVERHEAD_TOKENS = 512;

/**
 * 压缩收益判据（P1-3）：压一次要花「原文 R + 摘要 S」。
 * 决策最多只预测 2 个后续复用轮次；真实净节省另按成功请求实际携带摘要的次数累计。
 *
 * 审计给的算式就是这条：回本所需轮数 `> (R + S) / (R − S)`。原实现用字符阈值（2,400 字符）判，
 * 于是刚过线的结果要再被用 4~5 轮才回本 —— 短任务里反而更贵。
 *
 * @param {{contentTokens?: number, summaryTokens?: number, remainingRounds?: number, costTokens?: number}} [input]
 * @returns {{savedPerRound: number, cost: number, roundsToBreakEven: number, profitable: boolean}}
 */
function compressionRoi(input = {}) {
  const content = Number(input.contentTokens) || 0;
  const summary = Number(input.summaryTokens) || 0;
  const remaining = Number(input.remainingRounds) || 0;
  const extra = Number(input.costTokens) || 0;
  const savedPerRound = content - summary;
  const cost = content + summary + extra;
  const roundsToBreakEven = savedPerRound > 0 ? cost / savedPerRound : Infinity;
  return {
    savedPerRound,
    cost,
    roundsToBreakEven,
    profitable: savedPerRound > 0 && remaining * savedPerRound > cost,
  };
}

/**
 * 该不该对这一条工具结果做 LLM 压缩（P1-3 的完整判据；`shouldCompress` 只做旧口径的粗筛）。
 *
 * 顺序（每一条都有明确理由）：
 *   ① 旧粗筛（开关 / exclude / max_calls / 旧字符下界）—— 保持既有语义与既有用例；
 *   ② **token 阈值**（出厂 8,000）：先做确定性投影/分页/句柄，投影后还这么大才轮到 LLM 摘要；
 *   ③ **预计复用轮数**：剩余上限未知或不 > 1 → 不压；
 *   ④ **同类工具长期净亏** → 本 run 内改用确定性裁剪（自动降级，见 `stats`）；
 *   ⑤ **净收益判据** `min(剩余上限, 2) × (R − S) > (R + S)`。
 * @returns {{compress: false, reason: string, roi?: object}|
 *           {compress: true, reason: string, roi: object, expectedReuseRounds: number, maximumRemainingRounds: number}}
 */
function compressionDecision(input = {}) {
  const comp = input.compression || {};
  const usedCalls = Number(input.usedCalls) || 0;
  if (!shouldCompress(comp, input.toolName, Number(input.contentChars) || 0, usedCalls)) {
    return { compress: false, reason: 'legacy-gate' };
  }
  const thresholdTokens = Number(comp.thresholdTokens) > 0 ? Number(comp.thresholdTokens) : 8000;
  if (!(Number(input.contentTokens) >= thresholdTokens)) return { compress: false, reason: 'below-token-threshold' };
  const maximumRemaining = Number(input.remainingRounds);
  if (!Number.isFinite(maximumRemaining) || maximumRemaining <= 1) return { compress: false, reason: 'last-round' };
  const stats = input.stats && typeof input.stats.get === 'function' ? input.stats.get(input.toolName) : null;
  if (stats && Number(stats.calls) >= 2 && Number(stats.netTokensSaved) < 0) {
    return { compress: false, reason: 'negative-net' };
  }
  const expectedReuseRounds = Math.min(maximumRemaining, MAX_COMPRESSION_FORECAST_ROUNDS);
  const roi = compressionRoi({
    contentTokens: input.contentTokens,
    summaryTokens: Number(comp.summaryTokens) > 0 ? Number(comp.summaryTokens) : 1500,
    remainingRounds: expectedReuseRounds,
    costTokens: COMPRESSION_ESTIMATED_FIXED_OVERHEAD_TOKENS,
  });
  if (!roi.profitable) return { compress: false, reason: 'roi-negative', roi };
  return { compress: true, reason: 'profitable', roi, expectedReuseRounds, maximumRemainingRounds: maximumRemaining };
}

/** 压缩结果的内容级缓存（同一份原文 + 同一预算只压一次，命中即零 token） */
const compressionLib = require('./compressionCache.cjs');

/**
 * 批量压缩（S10）：同一轮工具循环里的**多份**大结果合并成一次压缩请求。
 *
 * 为什么：逐个压缩时，每次请求都要重付一遍 system 前缀和请求固定开销（连接、重试、输出模板），
 * 而 system 是常量、服务端前缀缓存只对「前缀」有效 —— 合并成一次请求，这些开销只付一次。
 * 质量上的风险（模型把多份结果混成一锅）用「强制分段标记 + 缺失项逐条兜底」挡住：
 * 解析不出某一段就对该条退回单条压缩路径，信息不会丢。
 */
const COMPRESSION_BATCH_REQUEST =
  '下面是同一轮工具循环中的多份工具结果。请**逐份**压缩：不要合并、不要遗漏、不要改动序号，\n' +
  '每份摘要前单独一行输出标记 <!-- summary i=序号 -->，序号与输入里 index 属性一致。';

/** 批量输出的段标记（解析用）：`<!-- summary i=1 -->` */
const COMPRESSION_BATCH_MARK_RE = /<!--\s*summary\s*i=(\d+)\s*-->/gi;

/**
 * 组装批量压缩请求。system 与单条路径共用同一个常量 → 两条路径的前缀完全一致。
 * @param {Array<{toolName: string, content: string}>} items
 * @param {number} budgetChars
 */
function buildCompressionBatchMessages(items, budgetChars) {
  const parts = (Array.isArray(items) ? items : []).map(
    (item, i) =>
      '<tool_result index="' + (i + 1) + '" name="' + String((item && item.toolName) || '') + '">\n' +
      String((item && item.content) || '') +
      '\n</tool_result>',
  );
  return [
    { role: 'system', content: COMPRESSOR_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        COMPRESSION_BATCH_REQUEST + '\n每份摘要控制在约 ' + budgetChars + ' 字符内。\n\n' + parts.join('\n\n'),
    },
  ];
}

/**
 * 解析批量压缩输出。
 * @param {string} text 模型输出
 * @param {number[]} indexes 期望的段序号（1 基）
 * @returns {{summaries: Map<number, string>, missing: number[]}}
 */
function parseCompressionBatchOutput(text, indexes) {
  const src = String(text || '');
  const expected = Array.isArray(indexes) ? indexes.slice() : [];
  const hits = [];
  COMPRESSION_BATCH_MARK_RE.lastIndex = 0;
  let m = COMPRESSION_BATCH_MARK_RE.exec(src);
  while (m) {
    hits.push({ index: Number(m[1]), at: m.index, after: COMPRESSION_BATCH_MARK_RE.lastIndex });
    m = COMPRESSION_BATCH_MARK_RE.exec(src);
  }
  /** @type {Map<number, string>} */
  const summaries = new Map();
  for (let i = 0; i < hits.length; i++) {
    const stop = i + 1 < hits.length ? hits[i + 1].at : src.length;
    const body = src.slice(hits[i].after, stop).trim();
    if (body) summaries.set(hits[i].index, body);
  }
  return { summaries, missing: expected.filter((idx) => !summaries.has(idx)) };
}

/**
 * 按「每批条数」与「每批字符上限」切分待压缩项（保持顺序）。
 * @param {Array<any>} items
 * @param {number} maxItems
 * @param {number} maxChars
 * @returns {Array<Array<any>>}
 */
function chunkCompressionItems(items, maxItems, maxChars) {
  const list = Array.isArray(items) ? items : [];
  const limitItems = Math.max(1, Number(maxItems) || 1);
  const limitChars = Math.max(1, Number(maxChars) || 1);
  /** @type {Array<Array<any>>} */
  const batches = [];
  /** @type {Array<any>} */
  let current = [];
  let chars = 0;
  for (const item of list) {
    const size = String((item && item.content) || '').length;
    if (current.length && (current.length >= limitItems || chars + size > limitChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** 执行一次批量压缩请求；失败或解析失败都返回空结果（由调用方逐条兜底）。 */
async function runCompressionBatchRequest(cfg, batch, signal, options, budget) {
  const comp = (cfg && cfg.compression) || {};
  const chat = typeof options.chat === 'function' ? options.chat : chatCompletion;
  const model = String(comp.model || '').trim() || cfg.model;
  const messages = buildCompressionBatchMessages(
    batch.map((entry) => ({ toolName: entry.item.toolName, content: entry.item.content })),
    budget,
  );
  try {
    const startedAt = Date.now();
    /** @type {any} */
    const body = { ...cfg, model, modelTaskType: 'compression', costKind: 'compression', maxTokens: Math.min(cfg.maxTokens || 8192, comp.maxOutputTokens || 4096) };
    if (comp.reasoning !== true) body.reasoningEffort = false;
    const res = await chat(body, messages, { timeoutMs: comp.timeoutMs || 60000, signal });
    if (res.usage) recordCost(cfg, {
      kind: 'compression',
      model: res.actualModel || model,
      usage: res.usage,
      attempt: res.httpAttempts,
      latencyMs: Date.now() - startedAt,
      runId: cfg.costRunId,
      meta: { batchSize: batch.length, tools: batch.map((entry) => entry.item.toolName), perAttempt: true },
    });
    return parseCompressionBatchOutput(res.content, batch.map((entry) => entry.index + 1));
  } catch {
    return { summaries: new Map(), missing: batch.map((entry) => entry.index + 1) };
  }
}

/**
 * 批量压缩入口：先吃内容级缓存，剩下的合并成一次请求；任何一段拿不到就退回单条压缩。
 * @param {any} cfg
 * @param {Array<{toolName: string, content: string}>} items
 * @param {AbortSignal|null} [signal]
 * @param {{projectRoot?: string|null, chat?: Function}} [options]
 * @returns {Promise<Array<{text: string, cacheHit: boolean, batched: boolean, degraded: boolean}>>}
 */
async function compressToolBatch(cfg, items, signal, options) {
  const o = options || {};
  const comp = (cfg && cfg.compression) || {};
  const budget = comp.budgetChars || 1500;
  const cache = comp.cache === false ? null : compressionLib.getCompressionCache(o.projectRoot || null);
  const list = Array.isArray(items) ? items : [];
  const results = list.map(() => ({ text: '', cacheHit: false, batched: false, degraded: false }));
  /** @type {Array<{index: number, item: any, key: string}>} */
  const pending = [];
  list.forEach((item, index) => {
    const key = cache ? compressionLib.compressionKey(item.toolName, budget, item.content) : '';
    const hit = cache && key ? cache.get(key) : null;
    if (hit) {
      results[index] = { text: hit, cacheHit: true, batched: false, degraded: false };
      return;
    }
    pending.push({ index, item, key });
  });
  if (!pending.length) return results;

  /** @type {Array<{index: number, item: any, key: string}>} */
  const fallback = [];
  if (comp.batch !== false && pending.length > 1) {
    const batches = chunkCompressionItems(pending, comp.batchMaxItems || 4, comp.maxInputChars || 300000);
    for (const batch of batches) {
      const parsed = await runCompressionBatchRequest(cfg, batch, signal, o, budget);
      batch.forEach((entry) => {
        const body = parsed.summaries.get(entry.index + 1);
        if (body) {
          results[entry.index] = { text: body, cacheHit: false, batched: true, degraded: false };
          if (cache && entry.key) cache.set(entry.key, body, entry.item.toolName);
        } else {
          fallback.push(entry);
        }
      });
    }
  } else {
    fallback.push(...pending);
  }
  for (const entry of fallback) {
    let cacheHit = false;
    const text = await compressToolContent(cfg, entry.item.toolName, entry.item.content, signal, {
      projectRoot: o.projectRoot,
      chat: o.chat,
      onCacheHit: () => {
        cacheHit = true;
      },
    });
    results[entry.index] = {
      text,
      cacheHit,
      batched: false,
      degraded: text.includes('子代理压缩失败'),
    };
  }
  return results;
}

/**
 * 子代理压缩：用一次独立的 LLM 调用把超大的工具结果压缩成关键信息摘要。
 * 子代理只看到原始结果本身（不共享主对话上下文）；失败时降级为截断，保证主 Agent 仍能拿到部分信息。
 *
 * 成本上做了三件事（用户反馈「这次压缩的缓存命中率极低」）：
 *   1. 内容级缓存：key = sha256(工具名 + 预算 + 原文)，同一份内容只付一次 prefill（可跨 run 复用，落盘）；
 *   2. system 恒定（COMPRESSOR_SYSTEM_PROMPT），预算搬到 user 段末尾 → 服务端前缀缓存能稳定命中前缀；
 *   3. 可用独立模型并默认关掉思考链（agent.compression.model / reasoning）——摘要任务不需要 reasoning tokens。
 *
 * @param {any} cfg
 * @param {string} toolName
 * @param {string} text
 * @param {AbortSignal|null} [signal]
 * @param {{projectRoot?: string|null, chat?: Function, onCacheHit?: (value: string) => void}} [options]
 * @returns {Promise<string>}
 */
async function compressToolContent(cfg, toolName, text, signal, options) {
  const o = options || {};
  const comp = (cfg && cfg.compression) || {};
  const budget = comp.budgetChars || 1500;
  const maxInput = comp.maxInputChars || 300000;
  const input = String(text || '');
  const clipped = input.length > maxInput ? input.slice(0, maxInput) + '\n…（输入过长，已截断）' : input;
  const cache = comp.cache === false ? null : compressionLib.getCompressionCache(o.projectRoot || null);
  const key = cache ? compressionLib.compressionKey(toolName, budget, clipped) : '';
  if (cache) {
    const hit = cache.get(key);
    if (hit) {
      if (typeof o.onCacheHit === 'function') o.onCacheHit(hit);
      return hit;
    }
  }
  const messages = [
    { role: 'system', content: COMPRESSOR_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        '<tool_result name="' + toolName + '">\n' + clipped + '\n</tool_result>\n' +
        '请把上述工具结果压缩成关键信息摘要，总长度控制在约 ' + budget + ' 字符内。',
    },
  ];
  const model = String(comp.model || '').trim() || cfg.model;
  // 可注入 chat（测试用；生产走 chatCompletion）—— 批量路径与单条路径共用同一个注入点
  const chat = typeof o.chat === 'function' ? o.chat : chatCompletion;
  try {
    const startedAt = Date.now();
    /** @type {any} */
    const body = { ...cfg, model, modelTaskType: 'compression', costKind: 'compression', maxTokens: Math.min(cfg.maxTokens || 8192, comp.maxOutputTokens || 4096) };
    // 摘要/搬运类任务不需要思考链：默认关掉 reasoning（agent.compression.reasoning=true 可打开）
    if (comp.reasoning !== true) body.reasoningEffort = false;
    const res = await chat(body, messages, { timeoutMs: comp.timeoutMs || 60000, signal });
    if (res.usage) recordCost(cfg, { kind: 'compression', model: res.actualModel || model, usage: res.usage, attempt: res.httpAttempts,
      latencyMs: Date.now() - startedAt, runId: cfg.costRunId, meta: { tool: toolName, perAttempt: true } });
    const out = String(res.content || '').trim();
    if (!out) return degradedOriginalText(text, '模型返回空摘要');
    if (cache) cache.set(key, out, toolName);
    return out;
  } catch (error) {
    return degradedOriginalText(text, (error && error.message) || error);
  }
}

/**
 * 压缩失败时的降级交付：**保留原文**，只加一行「未压缩」标注。
 *
 * 此前的做法是 `String(text).slice(0, budget)`（budget 默认 1500），上层却仍把它标成
 * 「已压缩」—— 一份最长 12 万字符的工具结果会被砍掉 98.7%，而模型只看到一句
 * 「子代理压缩失败，已截断」，于是它在一份**看起来正常**的结果上做出错误判断
 * （代码读了一半、JSON 被砍断）。原文本身已受过 dataTruncateCap 约束，保留它不会撑爆上下文。
 *
 * 注意：必须保留「子代理压缩失败」这几个字 —— 压缩缓存的 degraded 判定依赖它。
 * @param {any} text
 * @param {any} reason
 * @returns {string}
 */
function degradedOriginalText(text, reason) {
  return '【未压缩】子代理压缩失败（' + String(reason || '未知原因') + '），以下为工具返回的完整原文：\n' + String(text);
}

module.exports = {
  configure,
  COMPRESSOR_SYSTEM_PROMPT,
  MAX_COMPRESSION_FORECAST_ROUNDS,
  shouldCompress,
  compressionRoi,
  compressionDecision,
  buildCompressionBatchMessages,
  parseCompressionBatchOutput,
  chunkCompressionItems,
  compressToolBatch,
  compressToolContent,
};
