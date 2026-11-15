/**
 * CodeNode Agent 核心（参考 DeepSeek Harness 配置分层 + 原项目 Agent 工具）
 * - 配置：工程 .codenode/agent.properties 覆盖全局 config/agent.properties
 * - 灵魂：soul.md（初次注入语言风格/称呼/名字/问候）
 * - 对话：OpenAI 兼容 /chat/completions（默认 DeepSeek）；Claude 原生、Gemini 原生与 Azure 端点
 *   由 modelProtocol.cjs 适配（协议 / 认证头 / 请求体都在那一处，见该文件顶部说明）
 * - 会话：追加式 JSONL 记录（时间/角色/内容）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const retrievalDefaults = require('../config/ui.rag.json').defaults;
const runStore = require('./runStore.cjs');
// S8：统一运行事件流（.codenode/events.jsonl，带 runId/turnId/toolCallId/attemptId，可按 run 回放）
const eventBus = require('./eventBus.cjs');
const streamAccumulator = require('./streamAccumulator.cjs');
const FATAL_STREAM_ANOMALIES = new Set([
  'in-stream-error',
  'unparsable-data-line',
  'id-conflict',
  'finish-reason-changed',
]);
// 协议适配层（S13）：OpenAI 兼容 / Anthropic Messages / Gemini 原生 / Azure OpenAI 共用一个请求构造
const protocolLib = require('./modelProtocol.cjs');
const modelRouting = require('./modelRouting.cjs');
// 上下文压缩（照 Codex CLI 的做法）：窗口逼近上限时用交接摘要替换助手长文/工具结果
const compactionLib = require('./compaction.cjs');
const { parseContextConfig, parseCompactionConfig } = require('./agentContextConfig.cjs');
const { planBudgetCompaction } = require('./budgetCompaction.cjs');
// P1-2 动态上下文预算（键名与分配算法集中在那一处）
const dynamicContextLib = require('./dynamicContextBudget.cjs');
const piiLib = require('./pii.cjs');
const costAttribution = require('./costAttribution.cjs');
const costLedgerLib = require('./costLedger.cjs');
// 上下文预算：每次请求前把最旧的超大工具结果裁成占位符（见 electron/contextBudget.cjs 顶部注释）
const contextBudget = require('./contextBudget.cjs');
const { STATES, TERMINAL_STATES, describeOutcome, createStateMachine } = require('./agentState.cjs');
// 工具的只读/缓存/变更语义只有一份来源（electron/tools/descriptor.cjs），不再各文件各留一份名单
const TOOL_SEMANTICS = require('./tools/descriptor.cjs');
const { parsePrices: parseCostPrices } = require('./costLedger.cjs');
// S5：工具失败分类契约（FailureCode 唯一来源）—— 主循环据此分派提示与重试策略
const failures = require('./tools/failures.cjs');
// 「已改动文件」的唯一口径（子代理信封与这里的进度检查层共用同一份实现）
const { changedFilesFromToolCalls } = require('./tools/fileChanges.cjs');
// S6：只读并行调度（默认关闭；关闭时行为与串行执行完全一致）
const schedulerLib = require('./tools/scheduler.cjs');
// 任务清单（update_plan）：计划随进度提示一起回灌，否则模型几轮后就忘了自己承诺过什么
const planLib = require('./plan.cjs');
// 钩子（对照 Claude Code 的 hooks）：工具执行完之后按配置跑用户声明的命令（lint/测试/自定义脚本）
const hooksLib = require('./hooks.cjs');
const observationState = require('./observationState.cjs');
// 意图识别 / 授权判定（照 Codex guardian 分类器，见 electron/intent.cjs 顶部注释）
const intentLib = require('./intent.cjs');
const { parseThresholds: parseAlertThresholds } = require('./alerts.cjs');
const { validateRagGrounding, groundingWarning, groundingRetryPrompt } = require('./agentGrounding.cjs');
const agentCompression = require('./agentCompression.cjs');
const {
  COMPRESSOR_SYSTEM_PROMPT, MAX_COMPRESSION_FORECAST_ROUNDS, shouldCompress, compressionRoi, compressionDecision,
  buildCompressionBatchMessages, parseCompressionBatchOutput, chunkCompressionItems,
  compressToolBatch, compressToolContent,
} = agentCompression;
const {
  DEFAULTS, DEFAULT_MAX_TOKENS, DEFAULT_TURN_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TRUNCATION_NUDGES, configInteger, configNumber, configList,
  parseReasoningEffort, parseReliabilityConfig, parseSandboxConfig, parseLimitsConfig,
} = require('./agentRuntimeConfig.cjs');
agentCompression.configure({ chatCompletion, recordCost });

function loadProperties(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function loadConfig(projectRoot) {
  const globalCfg = loadProperties(path.join(__dirname, '..', 'config', 'agent.properties'));
  const projectCfg = projectRoot
    ? loadProperties(path.join(projectRoot, '.codenode', 'agent.properties'))
    : {};
  /** @type {Record<string, string>} */
  const cfg = { ...globalCfg, ...projectCfg };
  // Scheduling is global: project properties cannot give a shared model queue
  // a different limit from the subagent scheduler.
  const scheduling = require('./schedulingSettings.cjs').readSettings(globalCfg);
  require('./requestQueue.cjs').modelQueue.setLimit(scheduling.concurrency);
  return {
    apiBase: (cfg.api_base || 'https://api.deepseek.com').replace(/\/+$/, ''),
    /**
     * 协议 / 认证 / 端点（S13）：不填 = OpenAI 兼容 + Bearer（既有行为逐字节不变）。
     * 这三个键只影响「怎么发请求」；模型能力（思考链、视觉）仍由 models.json 的 supportsEffort / vision 决定。
     */
    // 未声明 = 空串（**不是** openai）：请求时按 API 地址自动判定，用户只填一个 key 就能用
    protocol: cfg.api_protocol ? protocolLib.normalizeProtocol(cfg.api_protocol) : '',
    auth: String(cfg.api_auth || '').trim(),
    endpoint: String(cfg.api_endpoint || '').trim(),
    apiVersion: String(cfg.api_version || '').trim(),
    azureDeployment: String(cfg.azure_deployment || '').trim(),
    anthropicVersion: String(cfg.anthropic_version || '').trim(),
    maxTokensField: String(cfg.max_tokens_field || '').trim() || 'max_tokens',
    apiKey: cfg.api_key || '',
    model: cfg.model || 'deepseek-v4-flash',
    maxTokens: Number(cfg.max_tokens) || DEFAULT_MAX_TOKENS,
    reasoningEffort: parseReasoningEffort(cfg.reasoning_effort),
    /**
     * `stream_options.include_usage` 是否随流式请求下发。默认 true（DeepSeek 用它报用量）；
     * 部分 OpenAI 兼容网关不认这个字段 → 400。**可关**（agent.send_stream_options=false）。
     */
    sendStreamOptions: cfg['agent.send_stream_options'] == null
      ? true
      : String(cfg['agent.send_stream_options']).toLowerCase() !== 'false',
    soulFile: cfg.soul_file || 'config/soul.md',
    soulEvolution: String(cfg['soul.evolution.enabled'] || 'true').toLowerCase() !== 'false',
    tools: parseToolsConfig(cfg),
    rag: parseRagConfig(cfg),
    dify: {
      enabled: String(cfg['dify.enabled'] || '').toLowerCase() === 'true' && !!cfg['dify.base'] && !!cfg['dify.api_key'],
      base: String(cfg['dify.base'] || '').trim().replace(/\/+$/, ''),
      apiKey: String(cfg['dify.api_key'] || '').trim(),
      kind: String(cfg['dify.kind'] || 'workflow').trim().toLowerCase(),
    },
    // 必须在 loadProperties 的原始键尚在时解析；过去把整个运行时 cfg 传给解析器会丢失 web_search.*。
    webSearch: require('./tools/impl/webSearchTool.cjs').parseWebSearchConfig(cfg),
    grounding: parseGroundingConfig(cfg),
    editing: require('./editingSettings.cjs').parseSettings(cfg),
    prompt: parsePromptConfig(cfg),
    intent: intentLib.parseIntentConfig(cfg),
    scalars: parseScalarsConfig(cfg),
    compression: parseCompressionConfig(cfg),
    observation: observationState.parseConfig(cfg),
    scheduling,
    subagent: { ...parseSubagentConfig(cfg), maxConcurrentTasks: scheduling.concurrency,
      maxTasksPerRun: scheduling.maxTasksPerRun, maxBatchTasks: scheduling.maxBatchTasks,
      warningPercent: scheduling.warningPercent, maxAttemptsPerTask: scheduling.maxAttemptsPerTask,
      maxAttemptsPerRun: scheduling.maxAttemptsPerRun },
    costSettings: require('./costSettings.cjs').parseSettings(cfg),
    reliability: parseReliabilityConfig(cfg),
    limits: parseLimitsConfig(cfg),
    context: parseContextConfig(cfg),
    compaction: parseCompactionConfig(cfg),
    sandbox: parseSandboxConfig(cfg),
    costPrices: parseCostPrices(cfg),
    costImageInputTokens: require('./costBudget.cjs').parseImageTokenBounds(cfg),
    modelRouting: modelRouting.parseConfig(cfg),
    alertThresholds: parseAlertThresholds(cfg),
    alertWebhook: String(cfg['alerts.webhook'] || '').trim(),
    memory: parseMemoryConfig(cfg),
    // P1-2 动态上下文预算（记忆 / RAG / 画布 / 技能共用一个池子）
    dynamicContext: parseDynamicContextConfig(cfg),
    pii: piiLib.parseConfig(cfg),
  };
}

/**
 * 记忆**自动注入**的预算（阶段 A / A4，token 效率审计 §4 P1-2）。
 *
 *   agent.memory_top_k                = 5      项目记忆最多注入几条（默认 5，旧值 30）
 *   agent.user_memory_top_k           = 3      用户级记忆最多几条（旧值 20）
 *   agent.memory_max_chars_per_entry  = 400    单条字符上限（旧：无上限）
 *   agent.memory_budget_tokens        = 2000   两类记忆**合计** token 上限（旧：无上限）
 *   agent.memory_inject               = matched | recent
 *        matched（默认）= 有命中才注入：无关键词命中时注入为空（需要时模型用 recall 检索）；
 *        recent          = 旧行为：无命中时回退最近 N 条。
 */
function parseMemoryConfig(cfg) {
  return {
    topK: configInteger(cfg, 'agent.memory_top_k', 5, 0, 30),
    userTopK: configInteger(cfg, 'agent.user_memory_top_k', 3, 0, 30),
    maxEntryChars: configInteger(cfg, 'agent.memory_max_chars_per_entry', 400, 0, 8000),
    budgetTokens: configInteger(cfg, 'agent.memory_budget_tokens', 2000, 0, 20000),
    requireMatch: String(cfg['agent.memory_inject'] == null ? 'matched' : cfg['agent.memory_inject']).trim().toLowerCase() !== 'recent',
  };
}

/**
 * 解析 `agent.dynamic_context_*`（P1-2 动态上下文预算）。键名的默认值与范围集中在
 * `dynamicContextBudget.cjs`，这里只转发 —— 避免两处各写一套默认值（历史上记忆的默认值就散过）。
 */
function parseDynamicContextConfig(cfg) {
  return dynamicContextLib.parseDynamicContextConfig(cfg || {});
}

/** 解析 tools.* 配置：tools.enabled / tools.allowed(逗号分隔) / tools.deny(逗号分隔) */
function parseToolsConfig(cfg) {
  const split = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    toolsEnabled: cfg['tools.enabled'] == null ? true : String(cfg['tools.enabled']).toLowerCase() !== 'false',
    toolsAllowed: split(cfg['tools.allowed']),
    toolsDeny: split(cfg['tools.deny']),
    // 默认普通文件读写和非删除画布编辑自动执行；其他操作及 HIGH 保留审批。
    toolsConfirmWrites: !require('./agentSettings.cjs').parseAutoExecution(cfg),
    // S6：只读并行（默认关闭 → 行为与串行一致）；并发上限 1–8
    toolsParallel: cfg['tools.parallel'] == null ? false : String(cfg['tools.parallel']).toLowerCase() === 'true',
    toolsParallelConcurrency: configInteger(cfg, 'tools.parallel_concurrency', 3, 1, 8),
    // P7 收口：文件遍历类工具（scan_project / find_files / search_files）在 worker 线程里跑（默认开）。
    // 关掉 = 退回主线程同步执行（会阻塞界面、且单次同步 fs 调用不可中断），仅供排障与老平台兜底。
    toolsFsWorker: cfg['tools.fs_worker'] == null ? true : String(cfg['tools.fs_worker']).toLowerCase() !== 'false',
    /**
     * 工具面分层（阶段 A / P0-1）。判定与名单在 `tools/profiles.cjs`（唯一来源）：
     *   `auto`（默认）= 按任务确定性裁剪：普通任务用 core+code，明确的单文件小改用 edit，
     *                    画布/调研/编排按信号追加；未下发的能力可通过 discover_tools 按需取回；
     *   `off`         = 不下发裁剪，暴露全部工具（与没有这个功能**逐字节一致**）；
     *   `core,code`   = 显式指定（core 永远在内，不做关键词推断）。注意显式指定也可能让运行规则
     *                   悬空（规则点名了没暴露的工具）→ agent.cjs 会按暴露面把对应规则行一并收敛。
     */
    toolProfile: String(cfg['agent.tool_profile'] == null ? 'auto' : cfg['agent.tool_profile']).trim(),
  };
}

/** 本地 Agentic RAG 配置；默认启用，只有 Agent 调用工具时才建立索引。 */
function parseRagConfig(cfg) {
  const chunkLines = configInteger(cfg, 'rag.chunk_lines', 72, 8, 400);
  return {
    enabled: cfg['rag.enabled'] == null ? retrievalDefaults.enabled : String(cfg['rag.enabled']).toLowerCase() !== 'false',
    maxFiles: configInteger(cfg, 'rag.max_files', 5000, 1, 50000),
    maxFileBytes: configInteger(cfg, 'rag.max_file_bytes', 512 * 1024, 1024, 8 * 1024 * 1024),
    maxDocumentBytes: configInteger(cfg, 'rag.max_document_mb', 20, 1, 100) * 1024 * 1024,
    chunkLines,
    chunkOverlap: configInteger(cfg, 'rag.chunk_overlap', 12, 0, Math.max(0, chunkLines - 1)),
    topK: configInteger(cfg, 'rag.top_k', 6, 1, 20),
    maxQueries: configInteger(cfg, 'rag.max_queries', 5, 1, 8),
    graphHops: configInteger(cfg, 'rag.graph_hops', 1, 0, 2),
    indexWorker: cfg['rag.index_worker'] == null || String(cfg['rag.index_worker']).toLowerCase() !== 'false',
    adjacentContextLines: configInteger(cfg, 'rag.adjacent_context_lines', 12, 0, 40),
    bm25K1: configNumber(cfg, 'rag.bm25_k1', 1.35, 0.1, 3),
    bm25B: configNumber(cfg, 'rag.bm25_b', 0.72, 0, 1),
    rerankUrl: cfg['rag.rerank_url'] || '',
    rerankModel: cfg['rag.rerank_model'] || '',
    rerankKey: cfg['rag.rerank_key'] || '',
    rerankTopK: configInteger(cfg, 'rag.rerank_top_k', 24, 4, 40),
    rerankTimeoutMs: configInteger(cfg, 'rag.rerank_timeout_ms', 10000, 1000, 60000),
    rerankMaxCostUsd: cfg['rag.rerank_max_cost_usd'] == null || cfg['rag.rerank_max_cost_usd'] === ''
      ? null : require('./costBudget.cjs').parseCostLimit(cfg['rag.rerank_max_cost_usd']),
    minCoverage: configNumber(cfg, 'rag.min_coverage', 0.2, 0.05, 1),
    include: configList(cfg, 'rag.include'),
    exclude: configList(cfg, 'rag.exclude'),
    maxContextChars: configInteger(cfg, 'rag.max_context_chars', 12000, 1000, 50000),
    embedProvider: (cfg['rag.embed_provider'] || retrievalDefaults.provider).toLowerCase().trim(),
    embedDim: configInteger(cfg, 'rag.embed_dim', 4096, 256, 8192),
    embedModel: cfg['rag.embed_model'] || '',
    embedBase: cfg['rag.embed_base'] || '',
    embedKey: cfg['rag.embed_key'] || '',
    // OpenAI v3 嵌入降维（如 1536 → 1024）；留空则用模型原生维度
    embedDimensions: cfg['rag.embed_dimensions'] || '',
    embedQueryPrefix: cfg['rag.embed_query_prefix'] || '',
    embedDocumentPrefix: cfg['rag.embed_document_prefix'] || '',
    embedTopK: configInteger(cfg, 'rag.embed_top_k', 40, 5, 500),
    memorySemanticMaxChunks: configInteger(cfg, 'rag.memory_semantic_max_chunks', 128, 0, 5000),
    vectorWeight: configNumber(cfg, 'rag.vector_weight', 0.35, 0, 1),
    // 向量后端：memory（默认，零外部服务）| milvus（外部 ANN，需 npm i @zilliz/milvus2-sdk-node）
    vectorStore: (cfg['rag.vector_store'] || retrievalDefaults.backend).toLowerCase().trim(),
    milvusAddress: cfg['rag.milvus_address'] || '',
    milvusToken: cfg['rag.milvus_token'] || '',
    milvusUsername: cfg['rag.milvus_username'] || '',
    milvusPassword: cfg['rag.milvus_password'] || '',
    milvusCollection: cfg['rag.milvus_collection'] || '',
    // 检索一致性：strong（默认，刚写入/删除立即可见）| bounded | eventually | session | default
    milvusConsistency: cfg['rag.milvus_consistency'] || 'strong',
    // Milvus 索引/检索/写入参数（生产档默认值：HNSW + M16/efConstruction200 + 检索 ef64 + 批量 128）
    milvusIndexType: cfg['rag.milvus_index_type'] || 'HNSW',
    milvusMetricType: cfg['rag.milvus_metric_type'] || 'COSINE',
    milvusIndexM: configInteger(cfg, 'rag.milvus_index_m', 16, 4, 2048),
    milvusIndexEfConstruction: configInteger(cfg, 'rag.milvus_index_ef_construction', 200, 8, 4096),
    milvusSearchEf: configInteger(cfg, 'rag.milvus_search_ef', 64, 8, 16384),
    milvusBatchSize: configInteger(cfg, 'rag.milvus_batch_size', 128, 1, 1024),
    milvusFlushEvery: configInteger(cfg, 'rag.milvus_flush_every_batches', 4, 1, 1000),
  };
}

/**
 * 来源校验（grounding）门配置（S10/P6）。
 *
 *   agent.grounding.mode        warn（默认）= 只上报（delta + 界面徽标），不拦交付；
 *                               enforce   = 引用不可信的答案不允许直接交付
 *   agent.grounding.max_retries enforce 下最多让模型订正几次（默认 1）
 *
 * 为什么默认 warn：引用校验本身会有误判（检索块级引用 vs 实读切片引用），把它变成硬门禁
 * 会让正确的回答被拦下。enforce 是给「有据可依才准交付」这类场景用的显式选择。
 */
/**
 * 提示词分层配置（③）。
 *
 *   agent.prompt_canvas_rules = auto（默认）| always | never
 *     auto   —— 画布为空且提问不含画布词时省掉画布层（纯代码任务省约 2.4k 字符/轮）
 *     always —— 永远注入（与分层前逐字节一致，逃生阀）
 *     never  —— 永远不注入（只做代码、从不建模的项目）
 * @param {any} cfg
 * @returns {{canvasRules: 'auto'|'always'|'never'}}
 */
function parsePromptConfig(cfg) {
  const raw = String((cfg && cfg['agent.prompt_canvas_rules']) || '').trim().toLowerCase();
  const canvasRules = /** @type {'auto'|'always'|'never'} */ (['auto', 'always', 'never'].includes(raw) ? raw : 'auto');
  return { canvasRules };
}

function parseGroundingConfig(cfg) {
  const mode = String(cfg['agent.grounding.mode'] || (retrievalDefaults.strictValidation ? 'enforce' : 'warn')).trim().toLowerCase();
  const semantic = String(cfg['agent.grounding.semantic_mode'] || (retrievalDefaults.strictValidation ? 'enforce' : 'off')).trim().toLowerCase();
  return {
    mode: mode === 'enforce' ? 'enforce' : 'warn',
    semanticMode: ['warn', 'enforce'].includes(semantic) ? semantic : 'off',
    // 兼容旧配置字段；检索不再额外调用模型规划问题。
    answerability: false,
    maxRetries: configInteger(cfg, 'agent.grounding.max_retries', 1, 0, 3),
  };
}

/** 本地标量存储配置：画布节点等精准数据是否落本地标量（不入云上下文）。 */
function parseScalarsConfig(cfg) {
  return {
    enabled: cfg['scalars.enabled'] == null ? true : String(cfg['scalars.enabled']).toLowerCase() !== 'false',
  };
}

/** 工具结果子代理压缩配置（压缩后的关键信息才返回上下文）。 */
function parseCompressionConfig(cfg) {
  const exclude = configList(cfg, 'agent.compression.exclude');
  const defaults = ['retrieve_context', 'query_scalars', 'ask_user'];
  return {
    enabled: cfg['agent.compression.enabled'] == null ? true : String(cfg['agent.compression.enabled']).toLowerCase() !== 'false',
    // P1-3：主口径改成 **token**（出厂 8,000）—— 旧字符阈值保留为**下界**（显式配过的老配置不会被悄悄放宽）
    thresholdTokens: configInteger(cfg, 'agent.compression.threshold_tokens', 8000, 500, 200000),
    /** 摘要的 token 预算（收益判据要拿它当 S；字符预算只用于给模型的长度指令） */
    summaryTokens: configInteger(cfg, 'agent.compression.summary_tokens', 1500, 100, 20000),
    thresholdChars: configInteger(cfg, 'agent.compression.threshold_chars', 2400, 200, 100000),
    budgetChars: configInteger(cfg, 'agent.compression.budget_chars', 1500, 200, 20000),
    maxCalls: configInteger(cfg, 'agent.compression.max_calls', 8, 0, 50),
    maxInputChars: configInteger(cfg, 'agent.compression.max_input_chars', 300000, 2000, 1000000),
    // S9 成本控制：压缩用哪个模型（空 = 跟随主模型）、是否开思考链（默认关）、
    // 内容级缓存（默认开，同一份原文只压一次）、输出/超时上限。
    model: String(cfg['agent.compression.model'] || '').trim(),
    reasoning: /^(1|true|yes|on)$/i.test(String(cfg['agent.compression.reasoning'] || '')),
    cache: cfg['agent.compression.cache'] == null ? true : String(cfg['agent.compression.cache']).toLowerCase() !== 'false',
    // S10：同一轮里的多份大结果合并成一次压缩请求（共享同一 system 前缀，请求开销只付一次）
    batch: cfg['agent.compression.batch'] == null ? true : String(cfg['agent.compression.batch']).toLowerCase() !== 'false',
    batchMaxItems: configInteger(cfg, 'agent.compression.batch_max_items', 4, 1, 16),
    maxOutputTokens: configInteger(cfg, 'agent.compression.max_output_tokens', 4096, 256, 65536),
    timeoutMs: configInteger(cfg, 'agent.compression.timeout_ms', 60000, 5000, 600000),
    exclude: defaults.concat(exclude.filter((item) => !defaults.includes(item))),
  };
}

/**
 * 子代理（delegate_task）配置（S9）。
 *
 *   agent.subagent.max_total_tokens  单个子代理的独立配额（默认 120000；0 = 仅共享父预算；
 *                                    两者都受 agent.max_total_tokens 约束，子代理永远不绕过 run 总量）
 *   agent.subagent.total_timeout_seconds  单个子代理任务的**总时长**（runAgentChat 的 timeoutMs 是单轮超时）
 *   agent.subagent.result_max_chars  回灌主上下文的子代理结果上限（超出截断并提示 get_subagent_task）
 */
function parseSubagentConfig(cfg) {
  const scheduling = require('./schedulingSettings.cjs').parseSettings(cfg);
  return {
    maxTotalTokens: configInteger(cfg, 'agent.subagent.max_total_tokens', 120000, 0, 4000000),
    totalTimeoutSeconds: configInteger(cfg, 'agent.subagent.total_timeout_seconds', 600, 10, 3600),
    resultMaxChars: configInteger(cfg, 'agent.subagent.result_max_chars', 8000, 500, 200000),
    maxTasksPerRun: scheduling.maxTasksPerRun,
    maxBatchTasks: scheduling.maxBatchTasks,
    maxConcurrentTasks: scheduling.concurrency,
    warningPercent: scheduling.warningPercent,
    maxAttemptsPerTask: scheduling.maxAttemptsPerTask,
    maxAttemptsPerRun: scheduling.maxAttemptsPerRun,
    // 跨 Agent 资源租约（多 Agent 信息完整性 P3）：同一资源同一时刻只允许一个写者
    leases: cfg['agent.subagent.leases'] == null ? true : String(cfg['agent.subagent.leases']).toLowerCase() !== 'false',
    leaseTtlMs: configInteger(cfg, 'agent.subagent.lease_ttl_ms', 120000, 5000, 3600000),
  };
}

/**
 * 统一成本记账：主模型 / 结果压缩 / 子代理 / 嵌入都写同一本账（electron/costLedger.cjs）。
 * 账本由主进程注入（cfg.costLedger），未注入时为空操作 —— 不编造数据。
 */
function recordCost(cfg, entry) {
  const ledger = cfg && cfg.costLedger;
  if (!ledger || typeof ledger.record !== 'function') return null;
  try {
    const model = entry.model || cfg.model;
    return ledger.record({ ...entry, taskId: cfg.costTaskId || entry.taskId || null,
      role: cfg.costRole || entry.role || 'main', executionId: cfg.costExecutionId || entry.executionId || null,
      prices: cfg.costPrices, model });
  } catch {
    return null;
  }
}

/**
 * 上下文预算（第 1 项缺陷的最小修复）：见 electron/contextBudget.cjs 顶部注释。
 *
 * 默认值依据（2026-09-17 实测）：40 次 27KB 的 read_file 结果会把第 11 次请求的输入顶到
 * 434,743 字符（≈145k tokens）—— 超过主流模型 128k 窗口，压缩配额用尽后原文直接进上下文。
 * 250,000 字符 ≈ 70k tokens 的保守估计，给 system 提示、工具 schema 与输出留出余量。
 */

/**
 * 上下文超窗（供应商 400）的识别与「窗口降级」账本。
 *
 * 为什么需要：压缩的触发线依赖**模型管理里填的 contextWindow**。如果那个值比供应商实际允许的
 * 窗口大（标称 1M、实际 128k 这种），压缩就会**迟于** 400 触发 —— 表现还是「聊一半断掉」。
 * 所以真被拒过一次之后，就把该模型的**保守窗口下限**记在进程内（不写用户配置），
 * 让压缩线立刻变得可信；同时本轮的请求压一次再重发，尽量把这次对话救回来。
 */
/**
 * 从供应商的超窗报错里抠出**真实数字**（拿不到就是 0）。
 *
 * 为什么必须优先用它：这里原先只用我们自己的启发式估算（`estimateTokens × 0.9`）当窗口下限，
 * 实测会锁到真实窗口的 56%（供应商说 "maximum context length is 1048576"，我们却锁成 590,035），
 * 而那个值又被预检当成硬门槛 —— 于是一次**与输入无关**的 400（真实成因是「输入 + max_tokens 超窗」）
 * 会让这份历史在该进程内永久发不出去。供应商的报错里通常直接写着真实窗口，能解析就用它。
 * @param {string} message
 * @returns {{ window: number, inputTokens: number }}
 */
const { parseOverflowNumbers, noteContextOverflow, getContextWindowOverride, isContextWindowOverrideAuthoritative, resetContextWindowOverrides, classifyContextOverflow } = require('./agentOverflow.cjs');

/**
 * 上下文压缩（照 **Codex CLI** 的做法）：提示词、触发线、新历史形状都取自 Codex 的实测行为，
 * 详见 electron/compaction.cjs 顶部注释（含取证来源与行号级依据）。
 *
 * 与 `agent.context.*`（硬裁剪兜底）的分工：本层是**语义**压缩（质量优先，一次模型调用换一份
 * 交接摘要），硬裁剪保证「压不动时请求仍然发得出去」。两层都留痕（compaction_* / context_trim）。
 */

const { resolveSoulPath, loadSoul, parseSoul, buildToolGuide, CANVAS_RULES, CANVAS_RULES_STUB, RUNTIME_RULE_GATES, RUNTIME_RULE_DISCOVER, TASK_RULE_NUMBERS, TASK_RULES_TITLE, PROMPT_SECTIONS, splitRuntimeRules, truncateCanvasSummary, truncateSkillsIndex, orderPromptSections, splitPromptSections, resolvePromptLayers, buildModelIdentityBlock, buildSystemPrompt } = require('./agentPrompt.cjs');

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isAbortError(error) {
  return !!error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || error)));
}

function retryDelay(cfg, attempt, retryAfter) {
  const reliability = (cfg && cfg.reliability) || {};
  const base = Number(reliability.retryBaseMs) || 400;
  const max = Number(reliability.retryMaxMs) || 5000;
  const serverDelay = retryAfter == null || String(retryAfter).trim() === '' ? NaN : Number(retryAfter);
  if (Number.isFinite(serverDelay) && serverDelay >= 0) return Math.min(max, Math.max(0, serverDelay * 1000));
  const exponential = Math.min(max, base * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(exponential * (0.8 + Math.random() * 0.4));
  return Math.min(max, jitter);
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal && signal.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    };
    timer = setTimeout(() => {
      signal && signal.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, Math.max(0, ms));
    signal && signal.addEventListener('abort', onAbort, { once: true });
  });
}

function maxAttemptsFor(cfg) {
  const attempts = cfg && cfg.reliability && cfg.reliability.maxAttempts;
  return Math.max(1, Math.min(5, Number(attempts) || 3));
}

/**
 * @param {any} cfg
 * @param {Array<any>} messages
 * @param {{ signal?: AbortSignal, tools?: any, timeoutMs?: number, taskType?: string, onModelEvent?: Function }} [options]
 */
async function chatCompletion(cfg, messages, options = {}) {
  // Count actual HTTP sends, including connection retries.
  const attemptsRef = { count: 0, maxAttempts: maxAttemptsFor(cfg) };
  const result = await require('./requestQueue.cjs').modelQueue.run(options.signal,
    async () => {
      const span = cfg.traceProjectRoot ? eventBus.startSpan(cfg.traceProjectRoot, {
        spanKind: 'model', name: 'model.request', runId: cfg.costRunId || cfg.traceContext?.runId,
        parent: cfg.traceContext, actor: cfg.costKind || 'main', attributes: { taskType: cfg.modelTaskType || 'main' },
      }) : null;
      try {
        const result = await modelRouting.run(cfg, { ...options, timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000,
          waitForRetry: (attempt, signal) => waitForRetry(retryDelay(cfg, attempt), signal),
        }, options.onModelEvent || cfg.onModelEvent, attemptsRef,
        (actualCfg, attemptOptions) => require('./requestBudget.cjs').withAttemptBudget(
          { ...actualCfg, traceContext: span ? span.context : actualCfg.traceContext, traceProjectRoot: cfg.traceProjectRoot }, messages, [],
          budgetedCfg => chatCompletionInternal({ ...actualCfg, maxTokens: budgetedCfg.maxTokens }, messages, { ...attemptOptions, attemptsRef }), attemptsRef,
        ));
        if (span) span.end(result?.error ? 'error' : 'ok', { model: result.actualModel || cfg.model, usage: result.usage });
        return { ...result, traceContext: span?.context || cfg.traceContext,
          requestTraceContext: attemptsRef.lastAttemptTraceContext || span?.context || cfg.traceContext };
      } catch (error) {
        if (span) span.end(eventBus.errorStatus(error), { error, model: cfg.model });
        throw error;
      }
    });
  return { ...result, httpAttempts: attemptsRef.count };
}

/**
 * @param {any} cfg
 * @param {Array<any>} messages
 * @param {{ signal?: AbortSignal, timeoutMs?: number, attemptsRef?: any }} [options]
 */
async function chatCompletionInternal(cfg, messages, { signal, timeoutMs = 120000, attemptsRef } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  // 协议层现算 URL / 认证头 / 请求体：非 OpenAI 协议（Claude / Gemini / Azure）在这里被翻译
  const request = protocolLib.buildRequest(cfg, messages, { stream: false });
  const url = request.url;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal && signal.addEventListener('abort', onAbort);
  try {
    const attempts = maxAttemptsFor(cfg);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let finishAttempt = null;
      try {
        finishAttempt = attemptsRef && typeof attemptsRef.beginAttempt === 'function'
          ? attemptsRef.beginAttempt() : null;
        const res = await fetch(url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
        });
        if (!res.ok) {
          if (finishAttempt) finishAttempt(null, { failed: true });
          finishAttempt = null;
          const text = await res.text().catch(() => '');
          const message = `HTTP ${res.status}: ${text.slice(0, 300)}`;
          if (isRetryableStatus(res.status) && attempt < attempts && !timedOut && !(signal && signal.aborted)) {
            await waitForRetry(retryDelay(cfg, attempt, res.headers && res.headers.get ? res.headers.get('retry-after') : null), controller.signal);
            continue;
          }
          throw Object.assign(new Error(message), { retryable: false, status: res.status });
        }
        /** @type {any} */
        const data = await res.json();
        // 协议层归一（OpenAI 分支与改造前逐字段一致；Claude / Gemini 在这里翻译成同一形状）
        const parsed = protocolLib.parseResponse(request.protocol, data);
        if (finishAttempt) finishAttempt(parsed.usage, {
          partialChars: String(parsed.content || '').length + String(parsed.reasoning || '').length,
        });
        return parsed;
      } catch (error) {
        if (finishAttempt) finishAttempt(null, { failed: true });
        lastError = error;
        if (timedOut || (signal && signal.aborted) || isAbortError(error) || error.retryable === false || attempt >= attempts) throw error;
        await waitForRetry(retryDelay(cfg, attempt), controller.signal);
      }
    }
    throw lastError || new Error('模型请求失败');
  } finally {
    clearTimeout(timer);
    signal && signal.removeEventListener('abort', onAbort);
  }
}

/** 进度检查提示的固定前缀：与 compaction 的 MACHINE_USER_PREFIXES 对齐（机器注入，不进摘要） */
const PROGRESS_NOTE_PREFIX = '【系统提示】进度检查（第 ';
const PLAN_NOTE_PREFIX = '【系统提示】当前任务计划（';

function buildPlanNote(plan) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) return '';
  return PLAN_NOTE_PREFIX + String(plan.sessionId || plan.runId || '当前会话') + '）：\n' +
    planLib.renderPlan(plan) +
    '\n状态约束：完成项必须引用本次实际成功的工具调用编号及结果；受阻或取消时写明原因；若步骤、验收标准或顺序变化，保留已有 id 并调用 update_plan 更新。';
}

/**
 * 生成一条**只讲可核对事实**的进度清单（不评价、不编造）。
 *
 * 为什么需要它：长任务里模型会陷在「又调一次同样的工具」或忘了最初目标（实测 12 轮上限里
 * 后几轮常在同一件事上打转）。Java 版的做法是每 3 步注入任务清单，这里对齐该口径 ——
 * 但只注入**事实**（轮次、调用数、改了哪些文件、失败过几次、用量），并要求下一步先交代
 * 目标/已完成/下一步，避免把「进度」变成又一段空话。
 *
 * @param {{iteration: number, maxIterations: number, toolCallsUsed: number, toolCallBudget: number,
 *          changedFiles?: string[], failures?: Array<{tool: string, code: string}>, tokensUsed?: number,
 *          tokenBudget?: number, plan?: {items?: Array<{step: string, status: string}>}|null}} input
 * @returns {string}
 */
function buildProgressNote(input) {
  const {
    iteration = 0,
    maxIterations = 0,
    toolCallsUsed = 0,
    toolCallBudget = 0,
    changedFiles = [],
    failures: recentFailures = [],
    tokensUsed = 0,
    tokenBudget = 0,
  } = input || {};
  const parts = [
    PROGRESS_NOTE_PREFIX + iteration + '/' + maxIterations + ' 轮）：' +
      '工具调用 ' + toolCallsUsed + (toolCallBudget > 0 ? '/' + toolCallBudget : '') + ' 次',
  ];
  parts.push('已改动文件 ' + (changedFiles.length ? changedFiles.length + ' 个（' + changedFiles.slice(0, 6).join('、') + '）' : '0 个'));
  parts.push('失败 ' + recentFailures.length + ' 次' + (recentFailures.length ? '（最近：' + recentFailures.slice(0, 3).map((f) => f.tool + (f.code ? '/' + f.code : '')).join('、') + '）' : ''));
  if (tokensUsed > 0) parts.push('用量 ' + tokensUsed + (tokenBudget > 0 ? '/' + tokenBudget : '') + ' tokens');
  return (
    parts.join('；') +
    '。' +
    '\n下一步先交代清楚三件事：① 当前目标（还在做哪一件事）② 已完成（以产物或命令输出为证）' +
    '③ 下一步要做的**一个**具体动作。这三项仅用于仍需调用工具时的进度说明；任务已完成时，直接回答用户问题并提供必要引用，不要用进度清单代替最终答案。不要重复已经成功过的调用（同参数重复会命中缓存，等于空转）。'
  );
}

/**
 * 读取本 run 的任务清单（`update_plan` 落在 `.codenode/runs/<runId>.plan.json`）。
 *
 * 为什么走文件而不是共享内存：工具（主进程里的 `registry.execute`）与主循环之间没有现成的
 * 可变状态通道，而 run 级文件本来就是这个仓库的既定口径（子代理任务视图同款），
 * 顺带让「删掉进程再续跑」也能把计划带回来。
 * 读不到（没写过计划 / 文件损坏 / 无 runId）一律返回 null —— 调用方按「没有计划」处理，不抛。
 *
 * @param {string|null} projectRoot @param {any} cfg
 * @returns {{items: Array<{step: string, status: string}>, updatedAt?: string}|null}
 */
/**
 * 项目 Skill 的**索引**（渐进披露）：只给名字 + 一句话，正文由模型调 `read_skill` 去读。
 * 单独成纯函数是为了让「到底注入了什么」可被判据直接锁住 —— 塞在 ipc 的表达式里时，
 * 用例只能自造一份索引文本来断言，等于什么都没锁（变异测试当场抓到）。
 * @param {Array<{name?: string, description?: string, instructions?: string}>} skills
 * @returns {string}
 */
function buildSkillsIndex(skills) {
  const list = Array.isArray(skills) ? skills.filter((s) => s && s.name) : [];
  if (!list.length) return '';
  return (
    list.map((item) => '- ' + item.name + ': ' + (item.description || '（详见正文，用 read_skill 读取）')).join('\n') +
    '\n（需要某个技能的完整做法时调用 read_skill(name) 读取）'
  );
}

function readRunPlan(projectRoot, cfg) {
  try {
    const sessionPlan = planLib.readSessionPlan(projectRoot, (cfg && cfg.planSessionId) || '');
    if (sessionPlan && planLib.isTerminalPlan(sessionPlan) && String(sessionPlan.runId || '') !== String((cfg && cfg.costRunId) || '')) return null;
    return sessionPlan || planLib.readPlan(projectRoot, (cfg && cfg.costRunId) || '');
  } catch {
    return null;
  }
}

/** 更新戳可能在同一毫秒重复；把规范化计划内容也纳入版本，避免漏掉连续更新。 */
function runPlanVersion(plan) {
  if (!plan) return '';
  return String(plan.updatedAt || '') + '\u0000' + JSON.stringify(Array.isArray(plan.items) ? plan.items : []);
}

/**
 * 构建**本次协议**的请求体（委托 modelProtocol.buildRequest）。
 * OpenAI 兼容档：模型 + 消息 + 推理强度 + 工具参数，`reasoning_effort` 只在模型支持时下发；
 * 其余协议（Anthropic / Gemini）在这里被翻译成各自的形状（system 提升、input_schema、functionDeclarations…）。
 */
function chatBody(cfg, messages, /** @type {{ stream?: boolean, tools?: any }} */ { stream, tools } = {}) {
  // 单一来源：请求体由协议层构造（modelProtocol.buildRequest）。
  // protocol 未声明 = OpenAI 兼容，产出的字段与字段顺序与改造前逐字节一致。
  return protocolLib.buildRequest(cfg, messages, { stream, tools }).body;
}

/**
 * 流式对话（SSE）：实时回调推理/内容/工具调用增量。tools 为 OpenAI tools 参数（可选）。
 */
async function chatCompletionStream(cfg, messages, onEvent, options = {}) {
  // One counter covers both inner HTTP retries and whole-stream restarts.
  const restarts = typeof options.streamMaxAttempts === 'number' && Number.isFinite(options.streamMaxAttempts)
    ? options.streamMaxAttempts : Number(cfg && cfg.reliability && cfg.reliability.streamMaxAttempts) || 0;
  // A shared ceiling prevents inner connection retries and outer stream
  // restarts from multiplying into request_max_attempts × stream_max_attempts.
  const attemptsRef = {
    count: Math.max(0, Number(options.retryOffset) || 0),
    maxAttempts: Math.max(0, Number(options.retryOffset) || 0) +
      maxAttemptsFor(cfg) + Math.max(0, Math.floor(restarts)),
  };
  const result = await require('./requestQueue.cjs').modelQueue.run(options.signal,
    async () => {
      const span = cfg.traceProjectRoot ? eventBus.startSpan(cfg.traceProjectRoot, {
        spanKind: 'model', name: 'model.stream', runId: cfg.costRunId || cfg.traceContext?.runId,
        parent: cfg.traceContext, actor: cfg.costKind || 'main', attributes: { taskType: cfg.modelTaskType || 'main' },
      }) : null;
      try {
        const result = await modelRouting.run(cfg, {
          ...options, timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs
            : Number(cfg?.reliability?.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS,
          waitForRetry: (attempt, signal) => waitForRetry(retryDelay(cfg, attempt), signal),
        }, onEvent, attemptsRef,
        (actualCfg, attemptOptions) => require('./requestBudget.cjs').withAttemptBudget(
          { ...actualCfg, traceContext: span ? span.context : actualCfg.traceContext, traceProjectRoot: cfg.traceProjectRoot }, messages, options.tools,
          budgetedCfg => chatCompletionStreamInternal({ ...actualCfg, maxTokens: budgetedCfg.maxTokens }, messages, onEvent, { ...attemptOptions, attemptsRef }), attemptsRef,
        ));
        if (span) span.end(result?.error ? 'error' : 'ok', { model: result.actualModel || cfg.model, usage: result.usage });
        return { ...result, traceContext: span?.context || cfg.traceContext,
          requestTraceContext: attemptsRef.lastAttemptTraceContext || span?.context || cfg.traceContext };
      } catch (error) {
        if (span) span.end(eventBus.errorStatus(error), { error, model: cfg.model });
        throw error;
      }
    });
  return { ...result, httpAttempts: attemptsRef.count };
}

/**
 * @param {any} cfg
 * @param {Array<any>} messages
 * @param {(event: any) => void} onEvent
 * @param {{ signal?: AbortSignal, timeoutMs?: number, idleTimeoutMs?: number, tools?: any, attemptsRef?: any }} [options]
 */
async function streamOnce(cfg, messages, onEvent, { signal, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS, tools, attemptsRef } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  // 协议层现算 URL / 认证头 / 请求体（重发时复用同一份，保证「整轮重发」发的是同一个请求）
  const request = protocolLib.buildRequest(cfg, messages, { stream: true, tools });
  const url = request.url;
  const controller = new AbortController();
  let timedOut = false;
  let stalled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // 停滞计时器：只要有分片到达就重置。它和上面的总时长上限是两件事 ——
  // 总上限抓「一整轮太久」，停滞抓「连接还活着但一个字都不来了」。
  let idleTimer = setTimeout(() => {
    stalled = true;
    controller.abort();
  }, idleTimeoutMs);
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const onAbort = () => controller.abort();
  signal && signal.addEventListener('abort', onAbort);
  let usage = null;
  /** 本尝试已流出的部分（供重发时如实上报「作废了多少字」） */
  /** @type {{content: string, reasoning: string, toolCalls: any[]}} */
  const partial = { content: '', reasoning: '', toolCalls: [] };
  const partialChars = () => partial.content.length + partial.reasoning.length +
    partial.toolCalls.reduce((sum, call) => sum + String(call.name || '').length + String(call.args || '').length, 0);
  let finishStreamAttempt = null;
  let accumulatorState = null;
  try {
    const body = request.body;
    const attempts = maxAttemptsFor(cfg);
    let res = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        finishStreamAttempt = attemptsRef && typeof attemptsRef.beginAttempt === 'function'
          ? attemptsRef.beginAttempt() : null;
        res = await fetch(url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) break;
        if (finishStreamAttempt) finishStreamAttempt(null, { failed: true });
        finishStreamAttempt = null;
        const text = await res.text().catch(() => '');
        if (isRetryableStatus(res.status) && attempt < attempts && !timedOut && !(signal && signal.aborted)) {
          await waitForRetry(retryDelay(cfg, attempt, res.headers && res.headers.get ? res.headers.get('retry-after') : null), controller.signal);
          continue;
        }
        throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { retryable: false, status: res.status });
      } catch (error) {
        if (finishStreamAttempt) finishStreamAttempt(null, { failed: true, partialChars: partialChars() });
        finishStreamAttempt = null;
        if (timedOut || stalled || (signal && signal.aborted) || isAbortError(error) || error.retryable === false || attempt >= attempts) throw error;
        await waitForRetry(retryDelay(cfg, attempt), controller.signal);
      }
    }
    if (!res || !res.body) throw new Error('模型响应没有可读取的流');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // 分片解析统一交给 streamAccumulator（纯函数、可单测）：重复/累积分片、index 漂移与复用、
    // finish_reason、坏 JSON 都在那里判定，主循环只把事件转成 onEvent。
    const state = streamAccumulator.createAccumulator();
    accumulatorState = state;
    /**
     * 协议翻译：Claude 的 `content_block_delta` / Gemini 的 `candidates[].parts` 在这里
     * 逐帧翻成 OpenAI 的 `choices[].delta` 文本 —— 于是「中途断线整轮重发 / 停滞判定 /
     * 用量帧归并 / 坏 JSON 记 anomaly」这套已经用测试锁死的语义，非 OpenAI 协议**原样复用**。
     * openai 协议下 translate 是恒等函数（零开销）。
     */
    const translator = protocolLib.createStreamTranslator(request.protocol);
    const forward = (events) => {
      for (const event of events) {
        if (!event) continue;
        if (event.kind === 'reasoning') {
          partial.reasoning += event.text;
          onEvent && onEvent({ kind: 'reasoning', text: event.text });
        } else if (event.kind === 'content') {
          partial.content += event.text;
          onEvent && onEvent({ kind: 'content', text: event.text });
        } else if (event.kind === 'tool') {
          partial.toolCalls = event.toolCalls || partial.toolCalls;
          onEvent && onEvent({ kind: 'tool', toolCalls: event.toolCalls });
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 有分片到达 = 连接还活着：重置停滞计时
      armIdle();
      forward(streamAccumulator.applySseText(state, translator.translate(decoder.decode(value, { stream: true }))));
    }
    // Some OpenAI-compatible providers omit the final newline. Do not drop its
    // last content/tool-call event, otherwise the agent may end the turn early.
    forward(streamAccumulator.applySseText(state, translator.translate(decoder.decode())));
    // 翻译层的残行与有终止依据时补出的收尾帧先落地，再让累加器收尾
    forward(streamAccumulator.applySseText(state, translator.flush()));
    forward(streamAccumulator.applySseText(state, '\n'));
    const final = streamAccumulator.finalize(state);
    // 正常 EOF 不代表模型完成；已识别的损坏帧交给主循环按 stream_error 归类。
    const hasFatalAnomaly = final.anomalies.some((item) => item && FATAL_STREAM_ANOMALIES.has(item.type));
    if (!final.done && final.finishReason == null && !hasFatalAnomaly) {
      throw Object.assign(new Error('模型流在结束标记（[DONE] 或 finish_reason）前关闭'), {
        code: 'STREAM_INCOMPLETE',
      });
    }
    usage = final.usage || usage;
    if (finishStreamAttempt) finishStreamAttempt(usage, { failed: hasFatalAnomaly, partialChars: partialChars() });
    finishStreamAttempt = null;
    return {
      content: final.content,
      reasoning: final.reasoning,
      toolCalls: final.toolCalls,
      usage,
      finishReason: final.finishReason,
      anomalies: final.anomalies,
      partial,
      stalled,
    };
  } catch (error) {
    if (finishStreamAttempt) finishStreamAttempt(accumulatorState && accumulatorState.usage,
      { failed: true, partialChars: partialChars() });
    finishStreamAttempt = null;
    // 标注失败形态，供「整轮重发」判断是卡住不动 / 连接被重置 / 总时长超限，
    // 并带上本尝试已流出的部分（报错文案要如实说「已收到多少字」）。
    if (error && typeof error === 'object') {
      error.stalled = stalled;
      error.timedOut = timedOut;
      error.partial = partial;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    signal && signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 一次「流式模型请求」的**整轮**语义（含中断重发）。
 *
 * 为什么需要它：网络或代理在流的中途重置时，此前只重试**建连**阶段 —— 一旦响应体开始
 * 流动，`reader.read()` 抛错就直接冒到主循环，用户看到的是「回答写一半突然没了」
 * 外加一句英文 `terminated`（实测：mock 服务吐 3 个分片后杀连接，服务端只收到 1 次请求）。
 *
 * 这里的策略是**丢弃半截、整轮重发**（不是拼接续写 —— 拼接会得到前后不一致的答案）：
 *   ① 重发前先发 `stream_restart` 事件，让主循环与界面把已流出的部分作废（否则两遍内容会叠在一起）；
 *   ② 停滞/断线可重发，**用户取消**与**总时长超限**不重发；
 *   ③ 重发次数用尽仍失败 → 抛带 `code`（STREAM_INTERRUPTED / STREAM_STALLED / TURN_TIMEOUT）
 *      与 `partial` 的中文错误，让调用方如实告诉用户「已收到多少字、为什么停」。
 *
 * @param {any} cfg
 * @param {Array<any>} messages
 * @param {(event: any) => void} onEvent
 * @param {{ signal?: AbortSignal, timeoutMs?: number, idleTimeoutMs?: number, streamMaxAttempts?: number, tools?: any, attemptsRef?: any }} [options]
 */
async function chatCompletionStreamInternal(cfg, messages, onEvent, options = {}) {
  const reliability = (cfg && cfg.reliability) || {};
  const signal = options.signal;
  const rawTimeoutMs = options.timeoutMs;
  const timeoutMs = Number.isFinite(rawTimeoutMs) ? Number(rawTimeoutMs) : Number(reliability.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : Number(reliability.streamIdleTimeoutMs) || DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const rawRestarts = options.streamMaxAttempts;
  const restarts = typeof rawRestarts === 'number' && Number.isFinite(rawRestarts) ? rawRestarts : Number(reliability.streamMaxAttempts) || 0;
  const totalAttempts = 1 + Math.max(0, restarts);
  const startedAt = Date.now();
  let firstError = null;
  let partial = { content: '', reasoning: '', toolCalls: [] };
  for (let attemptNo = 1; attemptNo <= totalAttempts; attemptNo++) {
    if (signal && signal.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
    if (attemptNo > 1) {
      onEvent &&
        onEvent({
          kind: 'stream_restart',
          attempt: attemptNo,
          maxAttempts: totalAttempts,
          reason: String((firstError && firstError.message) || firstError || ''),
          receivedChars: partial.content.length,
        });
      const waitMs = retryDelay(cfg, attemptNo - 1);
      if (waitMs > 0) await waitForRetry(waitMs, signal);
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw decoratedStreamError(new Error('本轮模型请求已达总时长上限'), {
        code: 'TURN_TIMEOUT',
        timeoutMs,
        partial,
        attempts: attemptNo - 1,
      });
    }
    try {
      const result = await streamOnce(cfg, messages, onEvent, {
        ...options,
        timeoutMs: remaining,
        idleTimeoutMs,
      });
      return { ...result, streamAttempts: attemptNo, streamRestarts: attemptNo - 1 };
    } catch (error) {
      // 用户主动停止：原样抛出（主循环按 signal.aborted 归类为 CANCELLED）
      if (signal && signal.aborted) throw error;
      if (error && (error.code === 'BUDGET_EXCEEDED' || error.code === 'RETRY_BUDGET_EXCEEDED' ||
        error.code === 'REQUEST_ATTEMPT_LIMIT' || error.code === 'COST_BUDGET_EXCEEDED' ||
        error.code === 'COST_PRICE_MISSING' || error.code === 'COST_CONFIG_INVALID' ||
        error.code === 'MODEL_ROUTING_CONFIG_INVALID')) throw error;
      const stalled = !!(error && error.stalled);
      const timedOut = !!(error && error.timedOut) || Date.now() - startedAt >= timeoutMs;
      if (error && error.partial) partial = error.partial;
      if (!firstError) firstError = error;
      const retryable = !timedOut && (stalled || error.retryable !== false);
      if (!retryable || attemptNo >= totalAttempts) {
        let code = 'STREAM_INTERRUPTED';
        if (timedOut) code = 'TURN_TIMEOUT';
        else if (stalled) code = 'STREAM_STALLED';
        else if (error && error.code === 'STREAM_INCOMPLETE') code = 'STREAM_INCOMPLETE';
        throw decoratedStreamError(error, {
          code,
          timeoutMs,
          idleTimeoutMs,
          partial,
          // 报的是**重发**次数（第 1 次不算重发），文案才与事实一致
          attempts: attemptNo - 1,
        });
      }
    }
  }
  /* istanbul ignore next —— 循环必然 return 或 throw，这里只为让分支闭合 */
  throw decoratedStreamError(firstError || new Error('模型请求失败'), { code: 'STREAM_INTERRUPTED', partial, attempts: totalAttempts });
}

/**
 * 把流式中断的底层错误包装成「用户/模型都能读懂」的错误：
 * 保留原始原因（排障要用），补上中文前缀与结构化字段（已收到多少字、重发了几次）。
 * `retryable: false` —— 主循环不应把这类错误当成工具失败再喂回模型重试一轮。
 */
function decoratedStreamError(error, info) {
  const original = String((error && error.message) || error || '未知原因');
  const received = String((info && info.partial && info.partial.content) || '').length;
  // 亚秒级的超时（测试里常用）要按 ms 显示，否则会写出「停滞（0s）」这种误导文案
  const fmtDuration = (ms) => {
    const n = Number(ms) || 0;
    return n >= 1000 ? Math.round(n / 1000) + 's' : Math.round(n) + 'ms';
  };
  let prefix;
  if (info && info.code === 'STREAM_STALLED') prefix = `模型响应停滞（${fmtDuration(info.idleTimeoutMs)} 内没有收到任何数据）`;
  else if (info && info.code === 'TURN_TIMEOUT') prefix = `本轮模型请求超过 ${fmtDuration(info.timeoutMs)} 总时长上限`;
  else if (info && info.code === 'STREAM_INCOMPLETE') prefix = '模型流式响应未完成';
  else prefix = '模型流式响应中断';
  const attemptsText = info && info.attempts > 0 ? `，已重发 ${info.attempts} 次` : '';
  const message = `${prefix}${received > 0 ? `（已收到 ${received} 字，这些内容不作为最终答复）` : ''}${attemptsText}：${original}`;
  return Object.assign(new Error(message), {
    code: (info && info.code) || 'STREAM_INTERRUPTED',
    retryable: false,
    streamPartial: (info && info.partial) || null,
    streamAttempts: (info && info.attempts) || 0,
    cause: error,
  });
}

function logConversation(projectRoot, entry) {
  if (!projectRoot) return;
  try {
    const dir = path.join(projectRoot, '.codenode');
    fs.mkdirSync(dir, { recursive: true });
    runStore.appendJsonl(path.join(dir, 'conversation.jsonl'), redactSecrets(entry));
  } catch {}
}

function redactSecrets(value) {
  return require('./redaction.cjs').redact(value);
}

const MAX_TOOL_ITERATIONS = 12;
const MAX_TOTAL_TOOL_CALLS = 100;
const DATA_TRUNCATE_CAP = 120000;

/**
 * 画布/标量类工具：结果本身已压缩到最小必要信息，完整属性已落本地标量库。
 * 这些工具返回的 [data] 不追加进上下文（避免把画布节点 prompt 等大段数据发送到云端）。
 * 名单定义在 tools/descriptor.cjs（唯一来源）。
 */
const SCALAR_BACKED_TOOLS = TOOL_SEMANTICS.SCALAR_BACKED_TOOLS;

/**
 * 相同参数重复调用时给模型的提示。**首次构建与缓存命中两条路径共用同一份文案** ——
 * 此前命中路径直接复用缓存的 content，而这个字段写进去时是空串（只有压缩成功才会回填），
 * 于是命中时退化成一行的裸 `result.text`：「请勿重复调用」提示与 `[data]` 段一起消失，
 * 模型看不到提示就会继续空转重试（第 8 节 #3 的探针就是在这里挖出真问题的）。
 */
const REPEAT_NOTICE = '（相同参数已重复调用，直接复用上次结果，请勿再次重复）';

/**
 * 组装发送给主模型（上下文）的工具结果消息内容。
 *
 * 两条口径：
 *   1. `result.modelContent != null`（A1 单份投影）：**只发它**，不再附加 `[data]` JSON。
 *      适用面是「text 与 data 说的是同一件事」的工具（find_files 的文件列表、search_files 的匹配
 *      列表、execute_shell 的命令输出、子代理任务的视图）—— 此前这些结果被发了两遍，
 *      随后的 LLM 压缩还要为这份重复付一次费（审计 §4 P0-2）。
 *   2. 缺省（`modelContent == null`，既有 60+ 处调用）：`text` + `[data]` JSON —— 与旧行为**逐字节一致**。
 *      SCALAR_BACKED_TOOLS 的结果不追加 [data]（已本地化）；其余按 cap 截断。
 */
function buildToolContent(result, toolName, malformed, repeated, cap) {
  const rawText = result.modelContent != null ? String(result.modelContent) : (result.text || (result.ok ? '（空）' : '（失败）'));
  // 截断**正文本身**：cap（agent.data_truncate_cap）此前只作用于下面的 [data] 附加段，
  // result.text 没有任何上限 —— 一次大目录扫描 / 大文件读取就能把上下文撑爆（审查 §3 P1）。
  // 截断必须带明确标记和「怎么拿剩余内容」的指引，否则模型会以为这就是全部内容。
  const text = rawText.length > cap
    ? rawText.slice(0, cap) + '\n…（结果过长已截断，共 ' + rawText.length + ' 字符。请缩小范围参数重试，或分页读取剩余内容）'
    : rawText;
  let content = repeated ? REPEAT_NOTICE + text : text;
  if (malformed) {
    content =
      '【参数格式错误】传给 ' + toolName + ' 的 arguments 不是合法 JSON（引号未转义等），解析后为空。请修正转义后重新调用，不要重复相同调用。\n' +
      content;
  }
  // A1：投影了就不再附加 [data]（那份数据仍然照旧交给 UI / 审计 / 回放，只是不发第二遍给模型）
  if (result.modelContent == null && result.data && typeof result.data === 'object' && Object.keys(result.data).length && !SCALAR_BACKED_TOOLS.has(toolName)) {
    try {
      const modelData = { ...result.data };
      delete modelData.evidenceText; // Original deep-read text is already present in the tool body.
      if (toolName === 'retrieve_context' && Array.isArray(modelData.sources)) {
        modelData.sources = modelData.sources.map(({ excerpt, text, content, snippet, ...metadata }) => metadata);
      }
      const dataJson = JSON.stringify(modelData);
      content += '\n[data] ' + (dataJson.length > cap ? dataJson.slice(0, cap) + '…（已截断，可用 offset/更小范围参数获取剩余）' : dataJson);
    } catch {}
  }
  return content;
}

/**
 * 只读/分析类工具：相同参数重复调用直接复用上次结果，避免模型空转。
 * 注意 1：get_workbench_model 不在此列——画布是权威读源，必须在变更后立即读到最新状态。
 * 注意 2：这个集合同时是「缓存保活白名单」——只有这些工具执行后缓存继续有效，其余一律清空（fail-closed）。
 * 能改文件/画布状态的不止写入类工具：execute_shell 跑脚本或构建、poll_job 轮询正在写盘的后台任务、
 * delegate_task 里 builder 子代理落盘、项目扩展与 MCP 工具执行外部命令，都曾不在写工具清单里，
 * 执行后缓存不失效 → 随后 read_file 命中旧结果（实测：shell 写入后 read_file 仍返回旧内容，磁盘已是新内容）。
 * 列举「谁可能写」永远列不全，所以反向枚举「谁一定只读」。
 */
const CACHEABLE_TOOLS = TOOL_SEMANTICS.CACHEABLE_TOOLS;

/** 会改变画布模型 / 文件 / 工程状态的工具（语义清单，供阅读与文档引用；定义在 descriptor.cjs）。 */
const MUTATION_TOOLS = TOOL_SEMANTICS.MUTATION_TOOLS;

/** 参数归一化：JSON 解析后按键排序重序列化，使语义相同的调用共享缓存键（消除引号转义/键顺序差异） */
const { canonicalArgs } = require('./toolArgs.cjs');

function parseToolArgs(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * 为一次模型回复里的每个 tool call 分配稳定 id：assistant 消息的 tool_calls[].id、
 * 随后 role:"tool" 消息的 tool_call_id、以及检查点/幂等账本里的 callId 必须完全相同。
 * 此前三处各自生成（assistant 用 tc.id || 随机、检查点用 tc.id || 'call_iter_n'、tool 消息用 tc.id || ''），
 * 供应商不返回 id 时会写出 tool_call_id:'' 的 tool 消息，与 assistant 声明的 id 对不上 → 下一轮请求 400。
 * @param {Array<any>} toolCalls
 * @param {number} iter
 * @returns {Array<any>}
 */
function assignCallIds(toolCalls, iter) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  list.forEach((tc, index) => {
    if (!tc || typeof tc !== 'object') return;
    const provided = tc.id == null ? '' : String(tc.id).trim();
    tc.callId = provided || 'call_' + iter + '_' + (index + 1);
  });
  return list;
}


/**
 * 追踪一次运行里的事件：**双写**
 *   1. `.codenode/tools_trace.jsonl`（旧文件，保留一个版本周期的兼容读取路径）；
 *   2. `.codenode/events.jsonl`（S8 统一事件流，带 runId/turnId/toolCallId/attemptId，
 *      可按 run / turn / 单次调用回放 —— 见 scripts/tools/event-replay.cjs）。
 * 事件流是旁路：写入失败只丢事件，绝不影响工具循环。
 */
function logToolTrace(projectRoot, entry) {
  if (!projectRoot) return;
  try {
    const dir = path.join(projectRoot, '.codenode');
    fs.mkdirSync(dir, { recursive: true });
    runStore.appendJsonl(path.join(dir, 'tools_trace.jsonl'), redactSecrets({ ts: new Date().toISOString(), ...entry }));
  } catch {}
  try {
    eventBus.emit(projectRoot, entry);
  } catch {}
}

/** 终端日志转义：非 ASCII 转成 \\uXXXX，避免 Windows 终端（GBK）把中文显示成乱码 */
function safeLog(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, (c) => {
    const cp = c.codePointAt(0) || 0;
    return cp <= 0xffff ? '\\u' + cp.toString(16).padStart(4, '0') : '\\u{' + cp.toString(16) + '}';
  });
}

/**
 * 累加两份 usage。
 *
 * 必须**深度**累加嵌套对象：此前只对顶层数字求和，`prompt_tokens_details` 这类嵌套字段
 * 只会保留第一轮的值（第二轮起被忽略）→ 子代理的缓存命中数被系统性低估，
 * 而命中率与「命中感知计费」直接依赖它。
 * @param {any} previous
 * @param {any} next
 */
function mergeUsage(previous, next) {
  if (!next || typeof next !== 'object') return previous || null;
  const merged = { ...(previous || {}) };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      merged[key] = (Number(merged[key]) || 0) + value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeUsage(merged[key] && typeof merged[key] === 'object' ? merged[key] : {}, value);
    } else if (merged[key] == null) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * 上限收尾（第 2 项缺陷的最小修复）。
 *
 * 缺陷：`agent.max_tool_iterations` / `agent.max_tool_calls` 触顶时只返回一句
 * 「已达到模型迭代上限，任务未完成。」——**已完成的部分、失败原因、涉及的文件、能不能续跑**
 * 全都没有；用户拿到的是一个看起来像报错的黑箱（而续跑入口又只列 interrupted 的 Run，
 * 上限中止的 Run 因为 status='error' 被过滤掉了，等于连续跑按钮都看不到）。
 *
 * 本函数只做「如实陈述」：把这一轮真实发生过的工具调用按工具名归类，列出失败与涉及文件，
 * 并说明续跑方式。**不做任何自动续跑**（是否继续由用户决定，且已提交的写操作由幂等账本保证不被重放）。
 */
function buildLimitWrapUp(options = {}) {
  const toolCalls = Array.isArray(options.toolCalls) ? options.toolCalls : [];
  const stopReason = options.stopReason || 'iteration_limit';
  /** @type {Map<string, {ok: number, failed: number}>} */
  const byName = new Map();
  /** @type {Set<string>} */
  const touched = new Set();
  /** @type {Array<{tool: string, code: string, message: string}>} */
  const failed = [];
  for (const call of toolCalls) {
    const name = String(call.name || 'unknown');
    const stats = byName.get(name) || { ok: 0, failed: 0 };
    if (call.ok === false) stats.failed += 1;
    else stats.ok += 1;
    byName.set(name, stats);
    const data = call.data || {};
    if (call.ok !== false) {
      if (typeof data.path === 'string' && data.path) touched.add(data.path);
      if (typeof data.file === 'string' && data.file) touched.add(data.file);
      if (Array.isArray(data.changedFiles)) for (const file of data.changedFiles) if (typeof file === 'string' && file) touched.add(file);
    }
    if (call.ok === false) {
      failed.push({
        tool: name,
        code: (call.failure && call.failure.code) || data.code || 'UNKNOWN',
        message: String((call.failure && call.failure.message) || call.result || '').slice(0, 200),
      });
    }
  }
  const executed = [...byName.entries()].map(([name, stats]) => ({ name, ...stats }));
  const doneText = executed.length
    ? executed.map((item) => item.name + '×' + item.ok + (item.failed ? '（失败 ' + item.failed + '）' : '')).join('、')
    : '（本轮没有成功完成的工具调用）';
  const lines = [];
  lines.push(['token_limit', 'cost_limit', 'retry_limit'].includes(stopReason) ? '【运行预算不足，任务未完成】' : stopReason === 'tool_limit' ? '【已达工具调用上限，任务未完成】' : '【已达模型迭代上限，任务未完成】');
  lines.push('- 已实际执行：' + doneText);
  if (failed.length) {
    lines.push('- 失败的调用：' + failed.map((item) => item.tool + '（' + item.code + '）').join('、'));
  }
  if (touched.size) {
    lines.push('- 涉及的文件（来自工具返回）：' + [...touched].slice(0, 10).join('、') + (touched.size > 10 ? ' 等 ' + touched.size + ' 个' : ''));
  }
  lines.push('- 接下来的选择：① 在界面上点「续跑」——会从断点检查点继续，已提交的写操作不会被重放；② 直接把下一步要做什么告诉我，我接着做。');
  return {
    text: lines.join('\n'),
    data: {
      stopReason,
      executed,
      failed,
      touchedFiles: [...touched],
      loopIterations: Number(options.loopIterations) || 0,
      modelTurns: Number(options.modelTurns) || 0,
      resumable: true,
    },
  };
}

/**
 * 带工具循环的 Agent 对话（ReAct）。
 * @param {object} opts
 *   cfg          loadConfig 返回值
 *   messages     已含 system 的完整消息数组（会被原地追加）
 *   onDelta       增量回调 {kind:'start'|'reasoning'|'content'|'tool'|'tool_result'|'grounding'|'done'|'error', ...}
 *   tools         { registry, context } 或 null（禁用工具）
 *   signal        AbortSignal（可选）
 *   timeoutMs     单轮模型请求的**总时长上限**（含流式中断后的重发；默认取
 *                 cfg.reliability.turnTimeoutMs，出厂 600s）。「停滞」与「重发次数」分别由
 *                 cfg.reliability.streamIdleTimeoutMs / streamMaxAttempts 控制。
 *   forceCompaction true = /compact（照 Codex 的手动压缩命令）：无视阈值立刻压一次
 * @returns {Promise<{content: any, reasoning: any, toolCalls: any, usage: any, error?: any, aborted?: boolean, stopReason?: string, finishReason?: string|null, state?: string, outcome?: {state: string, kind: string, reason: string|null, limitKind: string|null}, stateHistory?: Array<any>, grounding?: any, codeVerification?: any, taskAcceptance?: any, groundingBlocked?: boolean, groundingRetries?: number, contextTrims?: number, contextTrimmedChars?: number, wrapUp?: any, steps?: number, toolCount?: number, iterations?: number, streamRestarts?: number, compacted?: number, contextSummary?: string, contextSummaryEnvelope?: string, overflowRecoveries?: number, steeringInjected?: number}>}
 */
async function runAgentChatInternal({ cfg, messages, onDelta, tools, signal, timeoutMs = null, forceCompaction = false, steering = null }) {
  const generatedNotes = [PROGRESS_NOTE_PREFIX, PLAN_NOTE_PREFIX, hooksLib.HOOK_NOTE_PREFIX,
    '【任务回顾】', '【系统提示】任务验收契约：', '【系统提示】引用位置有效', '【系统提示】你上一条回答里的引用', '【系统提示】本轮已经检索到可用来源'];
  const lastUserContent = [...messages].reverse().find((message) => message.role === 'user' &&
    !(typeof message.content === 'string' && generatedNotes.some((prefix) => prefix && message.content.startsWith(prefix))))?.content;
  let groundingTask = typeof lastUserContent === 'string' ? lastUserContent : Array.isArray(lastUserContent)
    ? lastUserContent.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n') : '';
  // 单轮总时长：调用方显式传值优先（子代理按任务总时长钳制），否则读配置。
  const turnTimeoutMs = Number.isFinite(timeoutMs)
    ? Number(timeoutMs)
    : Number(cfg && cfg.reliability && cfg.reliability.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS;
  onDelta && onDelta({ kind: 'start' });
  // 状态机：把「执行中 / 等工具 / 等用户 / 完成 / 失败 / 取消 / 达上限」显式化，并逐次上报
  const machine = createStateMachine({
    runId: (cfg && cfg.costRunId) || null,
    onTransition: (info) =>
      onDelta && onDelta({ kind: 'state', state: info.to, previous: info.from, sequence: info.sequence, reason: info.reason, ts: info.ts }),
    onViolation: (violation) => onDelta && onDelta({ kind: 'state_violation', violation }),
  });
  const transitionState = (state, reason) => {
    const changed = machine.go(state, reason);
    if (!changed && machine.state !== state) {
      throw new Error('Agent 状态迁移被拒绝：' + machine.state + ' → ' + String(state));
    }
    return changed;
  };
  const finalizeState = (outcome, reason) => {
    const details = describeOutcome(outcome);
    if (!TERMINAL_STATES.includes(details.state)) throw new Error('Run 终态无效：' + String(details.state));
    if (!machine.isTerminal()) transitionState(details.state, reason || details.reason || details.kind);
    else if (machine.state !== details.state) transitionState(details.state, reason || details.reason || details.kind);
    return details;
  };
  onDelta && onDelta({ kind: 'state', state: machine.state, previous: null, sequence: 0, reason: 'start', ts: new Date().toISOString() });
  // 让工具上下文能把「等待用户」透传进来（子代理 fork 出的上下文不带钩子，由各自 run 自己安装）
  if (tools && tools.context && typeof tools.context.setStateNotifier === 'function') {
    tools.context.setStateNotifier((state, reason) => transitionState(state, reason));
  }
  let content = '';
  let toolRoundNarration = '';
  let reasoning = '';
  let usage = null;
  let totalTokens = 0;
  /** 本轮累计注入的用户插话条数（steering；0 = 没插过话，行为与无此功能时逐字节一致） */
  let steerCount = 0;
  const allToolCalls = [];
  const toolResultCache = new Map();
  const observationBoard = observationState.createBlackboard();
  /** @type {Record<string, number>} 每个 toolCallId 已发出的失败提示次数（S5：同一调用最多 NUDGE_MAX_PER_CALL 次） */
  const nudgeCounts = {};
  // S6：只读并行调度器（默认关闭 → prime() 返回空计划，主循环行为与串行完全一致）
  const toolScheduler = new schedulerLib.ToolScheduler({
    enabled: !!(cfg.tools && cfg.tools.toolsParallel === true),
    concurrency: (cfg.tools && cfg.tools.toolsParallelConcurrency) || schedulerLib.DEFAULT_CONCURRENCY,
  });
  const limits = (cfg && cfg.limits) || {};
  const maxToolIterations = limits.maxToolIterations > 0 ? limits.maxToolIterations : MAX_TOOL_ITERATIONS;
  const maxTotalToolCalls = limits.maxTotalToolCalls > 0 ? limits.maxTotalToolCalls : MAX_TOTAL_TOOL_CALLS;
  // 进度检查层：0 = 关闭（parseConfig 传的是 agent.progress_every，出厂 3；手工构造的 cfg 需要显式给）
  const progressEvery = Number(cfg && cfg.limits && cfg.limits.progressEvery) > 0 ? Math.floor(Number(cfg.limits.progressEvery)) : 0;
  // 只用于进度清单里的「用量 X/Y」显示；与下面预算门用的是同一个来源
  const progressTokenBudget = Number(cfg && cfg.limits && cfg.limits.maxTotalTokens) || 0;
  const dataTruncateCap = limits.dataTruncateCap > 0 ? limits.dataTruncateCap : DATA_TRUNCATE_CAP;
  // finish_reason=length 的补问上限：可配（agent.truncation_nudges），旧行为是写死 2 次。
  const maxTruncationNudges = Number.isFinite(cfg && cfg.reliability && cfg.reliability.truncationNudges)
    ? Math.max(0, Math.min(8, Number(cfg.reliability.truncationNudges)))
    : DEFAULT_TRUNCATION_NUDGES;
  // 上下文预算：压缩（质量优先的摘要）之外的**硬兜底** —— 压缩配额用尽/压缩关闭时上下文仍有界。
  const contextCfg = (cfg && cfg.context) || {};
  const resultArchive = require('./toolResultArchive.cjs').createArchive(tools?.context?.projectRoot?.(), { enabled: contextCfg.archiveResults === true, keepRecent: contextCfg.keepRecentMessages });
  const contextTrimEnabled = contextCfg.enabled !== false;
  const contextMaxChars = Number(contextCfg.maxInputChars) > 0 ? Number(contextCfg.maxInputChars) : 250000;
  const contextKeepRecent = Number.isFinite(Number(contextCfg.keepRecentMessages)) ? Number(contextCfg.keepRecentMessages) : 12;
  const contextMinResultChars = Number(contextCfg.minResultChars) > 0 ? Number(contextCfg.minResultChars) : 2000;
  const contextHardKeepRecent = Number.isFinite(Number(contextCfg.hardKeepRecentMessages)) ? Number(contextCfg.hardKeepRecentMessages) : 1;
  let contextTrimCount = 0;
  let contextTrimmedChars = 0;
  /**
   * 语义压缩（照 Codex CLI 的做法）：窗口逼近上限时，把「助手长文 + 工具结果」整段换成
   * 一份**交接摘要**，只保留 system 与人的轮次。与上面的硬裁剪是两层：
   *   - 摘要（本层，质量优先）：Context Checkpoint Compaction 提示词 + 模型产出摘要；
   *   - 硬裁剪（上面那层，兜底）：摘要不可用/失败时，仍保证请求不超预算。
   * 触发条件两个（任一成立即压）：① 估算输入 ≥ 有效窗口 × ratio（Codex 口径：窗口 90%）；
   * ② 上一轮已经**被迫硬裁剪**过（说明纯占位符换不出质量，该上摘要了）。
   */
  const compactionCfg = (cfg && cfg.compaction) || {};
  const compactionEnabled = compactionCfg.enabled === true;
  /** 模型管理里声明的窗口（0 = 没声明） */
  const declaredWindow = Number(cfg && cfg.contextWindow) > 0 ? Number(cfg.contextWindow) : 0;
  const configuredWindow = Number(compactionCfg.contextWindow) > 0 ? Number(compactionCfg.contextWindow) : 0;
  /** 供应商**真报过**超窗 → 进程内记下的窗口（报错里带了真实窗口才可信，否则只是估算下界） */
  const overflowWindow = getContextWindowOverride(cfg);
  /** 该值是否来自供应商明确报出的窗口（只有可信值才允许参与「预检拒发」） */
  const overflowTrusted = isContextWindowOverrideAuthoritative(cfg);
  const fallbackWindow = Number(compactionCfg.fallbackWindow) > 0 ? Number(compactionCfg.fallbackWindow) : 0;
  /**
   * 有效窗口 = 所有**已知**窗口里最保守（最小）的那个：供应商实测 / 用户声明 / 覆盖配置。
   *
   * 取最小而不是「供应商优先」：用户把窗口填小是想更早压缩（质量与成本取舍），
   * 不该被一次供应商实测值悄悄放宽；反过来，供应商实测比声明值小也必须立刻生效。
   * 只有全都没有时才退回兜底值（兜底值是猜的，只用来决定压缩时机，不参与拒发）。
   */
  const knownWindows = [overflowWindow, declaredWindow, configuredWindow].filter((value) => value > 0);
  const compactionWindow = knownWindows.length ? Math.min(...knownWindows) : fallbackWindow;
  /**
   * **预检拒发**只认可信窗口：用户声明/配置的，或供应商报错里**明确报出**的，同样取最小。
   * 由估算推导出来的下界绝不参与拒发 —— 实测它会锁到真实窗口的 56%（见 parseOverflowNumbers），
   * 一次与输入无关的 400 就会把这份历史在该进程内永久挡死。
   * 只剩兜底值时同样不拦：兜底值是猜的，拿它拒发会误伤大窗口模型（宁可发出去让供应商说真话）。
   */
  const trustedWindows = [overflowTrusted ? overflowWindow : 0, declaredWindow, configuredWindow].filter((value) => value > 0);
  const preflightWindow = trustedWindows.length ? Math.min(...trustedWindows) : 0;
  /** 输出预算收缩：可信窗口或真被拒过才做；纯兜底值不参与。 */
  const shrinkWindow = overflowWindow > 0 || preflightWindow > 0 ? compactionWindow : 0;
  /** 供应商报超窗 → 自动「降级窗口 + 压一次 + 重发」的次数上限（每个 run 一次就够，避免死循环烧钱） */
  const maxOverflowRecoveries = Number.isFinite(Number(compactionCfg.overflowRecoveries))
    ? Math.max(0, Math.min(3, Number(compactionCfg.overflowRecoveries)))
    : 1;
  let overflowRecoveries = 0;
  let compactionCount = 0;
  let budgetCompactionAttempted = false;
  let compactionWindowNumber = 0;
  let lastContextSummary = '';
  /** 上一轮硬裁剪的规模（tier≥1 表示「已经开始丢正文」→ 触发摘要） */
  let lastTrimStats = null;
  /**
   * P2-2：本 run 内「工具原始结果 → 模型可见投影」的累加器（按工具名），
   * 用来回答「哪类工具最该做确定性裁剪」。只统计，不参与任何决策。
   */
  const toolProjection = new Map();
  /** P2-2：上一次请求的 system 段落（缓存未命中时定位「第一个变化的区段」） */
  let lastAttributionSections = null;
  /** P2-1：上一轮模型输出里有没有工具调用（决定这一轮是「选工具」还是「交付/续写」） */
  let lastResponseHadToolCalls = false;
  /** P2-1：本 run 内被「加预算重试」抬起来过的输出预算（0 = 没抬过） */
  let outputBudgetOverride = 0;
  let truncationBumps = 0;
  /**
   * P1-3：本 run 的压缩账（按工具累计 原始/摘要/成本/净收益）。
   * `netTokensSaved` 只在后续主模型请求成功携带摘要后增加；两轮 forecast 只供压缩决策使用。
   * 用途二：**自动降级** —— 某类工具累计净亏且已压过 ≥2 次，本次 run 内不再对它调压缩模型，
   *         改走确定性裁剪（`data_truncate_cap` / 投影 / 分页）。
   */
  const compressionStats = new Map();
  /** 成功压缩后的 tool_call_id 与摘要；只在后续主模型请求确实带上它时兑现节省。 */
  const compressedCarryEntries = [];
  /** 本 run 被跳过的压缩次数（按原因计数），进 trace 与归因，别让「没压」变成不可观测的静默 */
  const compressionSkips = new Map();
  /** 本轮跳过的压缩原因（每轮清零）—— 用于「一条都没压」时也留一条 trace */
  const roundCompressionSkips = new Map();
  // P6：来源校验门（默认 warn = 只上报，行为与之前完全一致；enforce 才拦交付）
  const groundingCfg = (cfg && cfg.grounding) || {};
  const groundingEnforce = groundingCfg.mode === 'enforce';
  const semanticEnforce = groundingCfg.semanticMode === 'enforce';
  const strictDelivery = groundingEnforce || semanticEnforce;
  const deliveryRejected = (checked) => groundingEnforce && ['invalid', 'missing'].includes(checked.status) ||
    semanticEnforce && require('./rag/abstention.cjs').semanticRejected(checked.semantic);
  const maxGroundingRetries = Number.isFinite(groundingCfg.maxRetries) ? groundingCfg.maxRetries : 0;
  let groundingRetries = 0;
  let faithfulnessAnswer = null;
  let faithfulnessResult = null;
  const judgeDelivery = async (judgeMessages) => {
    const started = Date.now();
    const repairingFormat = judgeMessages.some(message => String(message.content || '').startsWith('JSON validation failed:'));
    const judged = await chatCompletion({ ...cfg, maxTokens: repairingFormat ? 6144 : 3072,
      jsonOutput: /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(cfg.apiBase), modelTaskType: 'faithfulness', costKind: 'faithfulness' },
      judgeMessages, { signal, timeoutMs: 30000 });
    if (judged.usage) recordCost(cfg, { kind: 'faithfulness', model: judged.actualModel || cfg.model,
      usage: judged.usage, attempt: judged.httpAttempts, latencyMs: Date.now() - started,
      runId: cfg.costRunId, meta: { perAttempt: true } });
    emitTrace({ kind: 'judge_protocol', finishReason: judged.finishReason || null,
      chars: String(judged.content || '').length, repairingFormat, error: judged.error || null });
    if (judged.error) throw new Error(judged.error);
    return { content: judged.content, finishReason: judged.finishReason };
  };
  const checkGrounding = async (answer) => {
    const checked = validateRagGrounding(answer, allToolCalls, { semanticMode: groundingCfg.semanticMode });
    const evidenceAttempted = allToolCalls.some((call) => ['read_file', 'retrieve_context', 'search_files', 'find_files', 'query_scalars'].includes(call.name));
    if (groundingCfg.semanticMode !== 'off' && groundingCfg.semanticMode && (checked.status !== 'not_required' || evidenceAttempted)) {
      const key = require('./rag/faithfulness.cjs').evidenceKey(answer, allToolCalls, groundingTask);
      if (faithfulnessAnswer !== key) {
        faithfulnessAnswer = key;
        faithfulnessResult = signal?.aborted ? { status: 'unknown', supported: false, reason: 'Cancelled' } : await require('./rag/faithfulness.cjs').verifyFaithfulness(answer, allToolCalls, judgeDelivery, { question: groundingTask });
        emitTrace({ kind: 'faithfulness', status: faithfulnessResult.status, supported: faithfulnessResult.supported });
      }
      checked.semantic = faithfulnessResult;
      if (faithfulnessResult?.status === 'abstained' && faithfulnessResult.safeForDelivery === true &&
        ['missing', 'not_required'].includes(checked.status) && !checked.used.length && !checked.invalid.length) {
        checked.status = 'valid'; checked.valid = true; checked.required = false;
      }
    }
    const root = traceProjectRoot();
    if (root && checked.status !== 'not_required' && !(faithfulnessResult?.status === 'abstained' && faithfulnessResult.safeForDelivery === true)) {
      const live = await require('./rag/liveVersions.cjs').checkLiveVersions(root, answer, allToolCalls, signal);
      checked.versionCheck = live;
      if (live.stalePaths.length || live.unknownPaths.length) {
        checked.status = 'invalid'; checked.valid = false;
        checked.invalid = [...new Set([...checked.invalid, ...live.stalePaths.map((path) => path + '（证据版本已变化）'),
          ...live.unknownPaths.map((path) => path + '（证据版本无法核验）')])];
      }
    }
    return checked;
  };
  /** S8：统一事件流 —— 每条事件都带本轮身份（runId/turnId[/toolCallId]），可按 run 回放 */
  const traceProjectRoot = () =>
    tools && tools.context && typeof tools.context.projectRoot === 'function' ? tools.context.projectRoot() : null;
  const emitTrace = (event, rootOverride) =>
    logToolTrace(rootOverride || traceProjectRoot(), Object.assign({ runId: (cfg && cfg.costRunId) || null }, event));
  const noProgressGuard = require('./noProgressGuard.cjs').createGuard({ root: traceProjectRoot(), limits, canonicalArgs, emitTrace, onDelta, signal });
  const cacheVersions = require('./tools/workspaceCache.cjs').createVersions(traceProjectRoot(), limits.workspaceCacheVersions === true, tools?.context);
  cfg = { ...cfg, onModelEvent: (event) => emitTrace(event) };
  let totalToolCalls = cfg.taskAcceptanceRunner?.calls || 0;
  let loopIterations = 0;
  /**
   * 上次注入进度提示时的计划版本（`update_plan` 写文件时带的 updatedAt）。
   * 计划一变就立刻刷新那条注入消息 —— 不能只在进度节奏（每 progressEvery 轮）才回灌，
   * 否则「模型刚写完计划、之后几轮都看不到它」。
   */
  let lastPlanStamp = '';
  // 计划卡（UI）用的独立游标：即使 progressEvery=0（不回灌进度提示），计划变化也要发给界面
  let lastPlanUiStamp = '';
  // 钩子（PostToolUse）：每 run 执行次数上限 + 最近几条结果（注入消息只保留最近几条，避免越积越长）
  const hooksCfg = hooksLib.parseHooksConfig(cfg);
  let hooksRunCount = 0;
  let hooksTruncated = false;
  /** @type {Array<{tool: string, rule: any, outcome: any}>} */
  const hookResults = [];
  const codeVerificationLib = require('./codeVerification.cjs');
  const codeVerifier = cfg.externalVerification === true ? null : traceProjectRoot() ? new codeVerificationLib.CodeVerifier(traceProjectRoot(), cfg.editing, {
    context: tools.context, policy: typeof tools.context.sandbox === 'function' ? tools.context.sandbox() : null,
    allowCommands: cfg.tools?.toolsEnabled !== false && !cfg.tools?.toolsDeny?.includes('execute_shell') &&
      (!cfg.tools?.toolsAllowed?.length || cfg.tools.toolsAllowed.includes('execute_shell')),
  }) : null;
  let verificationRetries = 0;
  const publishCodeVerification = (report, inject = true) => {
    if (!report) return;
    emitTrace({ kind: 'code_verification', report });
    onDelta && onDelta({ kind: 'code_verification', codeVerification: report });
    if (inject) {
      const note = codeVerificationLib.renderReport(report);
      const at = messages.findIndex((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(codeVerificationLib.PREFIX));
      if (at >= 0) messages[at] = { role: 'user', content: note };
      else messages.push({ role: 'user', content: note });
    }
  };
  /**
   * 真正**成功完成**的模型请求次数（每轮一次 chat completion，含截断补问那轮；
   * 请求失败/还没发出去的不计）。对外通过返回值 `iterations` 上报 —— 评测的
   * `steps-at-most` 判据用它。与 `loopIterations` 的差别：进入循环就被取消 /
   * 预算拦截 / 抛异常时循环体没走完，后者会多算一轮；而**流式分片数**（`kind:'tool'`
   * 的 delta 条数）更不能用：实测真实 DeepSeek 把 3 次工具调用切成 77 条 delta，
   * 拿它当「模型步数」会让上限判据恒红（2026-09-17 真实模型评测实测）。
   */
  let modelTurns = 0;
  let compressCalls = 0;
  let endedNaturally = false;
  let stopReason = 'iteration_limit';
  let lastFinishReason = null;
  let truncationNudges = 0;
  /** 本**轮**已流出的正文/思考（跨轮累加的是 content/reasoning；这两个只用于中断重发时回滚本轮） */
  let turnContent = '';
  let turnReasoning = '';
  /** 整轮重发的累计次数（流中途断线/停滞时发生；写进返回值与 turn_end trace，供事后判定真跑健壮性） */
  let streamRestarts = 0;
  /**
   * 执行一次「上下文压缩」（照 Codex CLI）：估算 → 必要时发摘要请求 → 用
   * `[system, ...人的轮次, 摘要]` 就地替换历史。返回 null 表示「不需要压」。
   *
   * 失败**不阻断**本轮（fail-open）：发 `compacted{ok:false}` 让界面与 run 记录都看得见 ——
   * 因为这一层失败意味着下一次请求很可能被供应商以「超上下文」拒掉，用户有权知道原因。
   * 真正的兜底是紧随其后的硬裁剪（contextBudget），所以这里不抛异常。
   */
  const runCompactionStep = async (iter, opts = {}) => {
    if (signal?.aborted) return null;
    if (!compactionEnabled || (!(compactionWindow > 0) && opts.trigger !== 'run-budget')) return null;
    const toolSpecs = tools && tools.registry && typeof tools.registry.toOpenAiTools === 'function' ? tools.registry.toOpenAiTools() : null;
    const tokens = compactionLib.estimateTokens(messages, toolSpecs);
    const compressible = compactionLib.countCompressible(messages);
    const plan = compactionLib.shouldCompact({
      tokens,
      contextWindow: compactionWindow,
      ratio: compactionCfg.ratio,
      compressible,
      // P1-4：把输入上限 / 输出预留 / 安全 buffer 统一进同一个触发公式（见 shouldCompact 注释）
      inputLimit: compactionCfg.inputLimit,
      outputReserve: Number(cfg.maxTokens) || 0,
      buffer: compactionCfg.bufferTokens,
    });
    const trimmedNow = !!(lastTrimStats && (lastTrimStats.trimmed > 0 || lastTrimStats.overBudget) && compactionCfg.onTrim !== false);
    /**
     * P1-4（审计 §4）：**先 compact，再做不可逆硬裁剪** —— 这一轮的硬裁剪要是真会丢正文，
     * 就先把语义压缩机会用掉（见下面 `before-trim` 的调用点）。
     */
    const beforeTrimNow = opts.beforeTrim === true;
    const forced = forceCompaction === true || opts.force === true;
    if (!forced && !plan.needed && !trimmedNow && !beforeTrimNow) return null;
    // /compact 强制压缩、但确实没东西可压（只剩 system 与人的话）：如实说明，别假装压过
    if (compressible <= 0) {
      emitTrace({ kind: 'compaction_skipped', turnId: iter, reason: 'nothing-to-compact', tokens });
      onDelta &&
        onDelta({
          kind: 'compacted',
          ok: false,
          reason: '没有可压缩的内容（当前历史只剩系统提示与人说的话）',
          tokensBefore: tokens,
          trigger: forced ? 'manual' : 'auto',
        });
      return { ok: false, error: 'nothing-to-compact' };
    }
    /** 触发来源：manual（/compact）/ over-limit（窗口阈值）/ before-trim（**还没丢正文**就先压）/
     *  after-trim（上一轮已经丢了正文，补救压缩）/ provider-rejected（供应商真报了超窗后的补救压缩） */
    const trigger = opts.trigger || (forced ? 'manual' : plan.needed ? 'over-limit' : 'after-trim');
    // 压缩进行中：机器轮次不保留（等价于 Codex 丢掉 <codex_internal_context> 那类注入）
    const machineTurns = messages.filter((m) => m && m.role === 'user' && compactionLib.isMachineInjectedUserMessage(String(m.content || ''))).length;
    emitTrace({
      kind: 'compaction_start',
      turnId: iter,
      tokens,
      limit: plan.limit,
      window: compactionWindow,
      ratio: compactionCfg.ratio,
      compressible,
      machineTurns,
      trigger,
    });
    onDelta && onDelta({ kind: 'compaction', phase: 'start', tokens, limit: plan.limit, window: compactionWindow, trigger });
    const built = compactionLib.buildSummarizationMessages({
      messages,
      itemMaxChars: compactionCfg.itemMaxChars,
      maxTotalChars: compactionCfg.inputMaxChars,
    });
    const compactCfg = compactionCfg.model
      ? { ...cfg, model: compactionCfg.model, maxTokens: compactionCfg.maxOutputTokens, reasoningEffort: compactionCfg.reasoning ? cfg.reasoningEffort : '' }
      : { ...cfg, maxTokens: compactionCfg.maxOutputTokens, reasoningEffort: compactionCfg.reasoning ? cfg.reasoningEffort : '' };
    compactCfg.modelTaskType = 'compaction';
    compactCfg.costKind = 'compaction';
    let compactActualModel = compactCfg.model;
    const startedAt = Date.now();
    let summary = '';
    let failure = '';
    try {
      signal?.throwIfAborted();
      const res = await chatCompletion(compactCfg, built.messages, { signal, timeoutMs: compactionCfg.timeoutMs });
      compactActualModel = res.actualModel || compactCfg.model;
      summary = String((res && res.content) || '').trim();
      if (res && res.usage) {
        recordCost(cfg, { kind: 'compaction', model: compactActualModel, usage: res.usage, attempt: res.httpAttempts,
          latencyMs: Date.now() - startedAt, runId: cfg.costRunId, meta: { perAttempt: true } });
      }
    } catch (error) {
      failure = String((error && error.message) || error);
    }
    if (!summary) {
      emitTrace({ kind: 'compaction_failed', turnId: iter, tokens, error: failure || '模型未返回摘要' });
      onDelta &&
        onDelta({
          kind: 'compacted',
          ok: false,
          reason: failure || '模型未返回摘要',
          tokensBefore: tokens,
          trigger,
        });
      return { ok: false, error: failure || '模型未返回摘要' };
    }
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    const systemMessage = messages.length && messages[0] && messages[0].role === 'system' ? messages[0] : null;
    const buildHistory = (tailBudget, strict = false) => compactionLib.buildCompactedHistory({
      systemMessage,
      messages,
      summary,
      keepUserTurns: compactionCfg.keepUserTurns !== false,
      keepUserMaxChars: compactionCfg.keepUserMaxChars,
      keepUserTotalChars: compactionCfg.keepUserTotalChars,
      // P1-4：摘要负责「很早以前」，这份无损尾部负责「刚刚」—— 原子保留最近的操作组
      keepTailTokens: tailBudget,
      // strict=true 时按「尊重预算」口径重算：单个超预算的大组会被整组丢弃
      allowOversizedTail: strict ? false : compactionCfg.tailAllowOversized === true,
    });
    const toolsForEstimate = tools && tools.registry && typeof tools.registry.toOpenAiTools === 'function' ? tools.registry.toOpenAiTools() : null;
    let rebuilt = buildHistory(compactionCfg.tailTokens);
    let after = compactionLib.estimateTokens(rebuilt.messages, toolsForEstimate);
    /**
     * **压缩必须真的把上下文压下来**（这一条是被现有用例抓出来的真缺陷）：
     * 无损尾部若把预算吃光，压缩后仍超过触发线 —— 下一轮立刻又压一次（甚至直接被预检判超窗，
     * 一次模型请求都发不出去）。所以：压完若仍在线上，就按「固定部分（system+人话+摘要）之外的余量」
     * 重算尾部预算，最多重算一次（纯计算、不额外花模型调用），并在 trace 里如实记下被缩过。
     */
    let tailShrunk = false;
    let tailDroppedForLimit = false;
    if (plan.limit > 0 && after >= plan.limit && compactionCfg.tailTokens > 0) {
      const fixed = Math.max(0, after - (rebuilt.tailTokens || 0));
      const slack = Math.max(0, plan.limit - fixed - 200); // 200 token 余量，别贴着线停
      const nextTail = Math.min(compactionCfg.tailTokens, slack);
      // 重算这一次用**严格预算**：否则「单组超预算就整组保留」会让重算永远收敛不到线下
      rebuilt = buildHistory(nextTail, true);
      after = compactionLib.estimateTokens(rebuilt.messages, toolsForEstimate);
      tailShrunk = true;
      tailDroppedForLimit = nextTail === 0;
    }
    if (trigger === 'run-budget') {
      const { estimateInputTokens } = require('./requestBudget.cjs');
      if (estimateInputTokens(rebuilt.messages, toolsForEstimate) >= estimateInputTokens(messages, toolsForEstimate)) {
        emitTrace({ kind: 'compaction_skipped', turnId: iter, reason: 'no-input-savings', trigger });
        onDelta && onDelta({ kind: 'compacted', ok: false, reason: '摘要未减少输入，保留原历史', trigger });
        return { ok: false, error: 'no-input-savings' };
      }
    }
    messages.splice(0, messages.length, ...rebuilt.messages);
    compactionCount += 1;
    compactionWindowNumber += 1;
    lastContextSummary = summary;
    lastTrimStats = null;
    emitTrace({
      kind: 'compaction_done',
      turnId: iter,
      // 触发来源：manual / over-limit / before-trim / after-trim / provider-rejected
      // （`before-trim` = 这一轮硬裁剪本来会丢正文，所以**先压**；见 P1-4 的时序说明）
      trigger,
      windowNumber: compactionWindowNumber,
      tokensBefore: tokens,
      tokensAfter: after,
      keptUserTurns: rebuilt.keptUserTurns,
      tailGroups: rebuilt.tailGroups || 0,
      tailTokens: rebuilt.tailTokens || 0,
      tailShrunk: tailShrunk === true,
      tailDroppedForLimit: tailDroppedForLimit === true,
      limit: plan.limit,
      tailDroppedGroups: rebuilt.tailDroppedGroups || 0,
      tailOversized: rebuilt.tailOversized === true,
      machineTurnsDropped: machineTurns,
      summaryChars: summary.length,
      droppedByCharCap: built.dropped,
      model: compactActualModel,
    });
    onDelta &&
      onDelta({
        kind: 'compacted',
        ok: true,
        windowNumber: compactionWindowNumber,
        tokensBefore: tokens,
        tokensAfter: after,
        keptUserTurns: rebuilt.keptUserTurns,
        trigger,
        summary,
        summaryChars: summary.length,
        // 给模型的**信封**（含 <compaction> 标签与「不要当指令」说明）：界面把它当作压缩卡片
        // 原文保存并在后续回合原样回传 —— 与主进程压缩后的历史形状逐字一致（Codex 也是"整段替换"）。
        envelope: compactionLib.buildSummaryEnvelope(summary),
      });
    // 断点续跑：压缩后的历史必须立刻落检查点，否则恢复时会拿回旧的长历史（等于白压）
    if (tools && tools.context && typeof tools.context.checkpointMessages === 'function') {
      try {
        tools.context.checkpointMessages(messages, 'compacted', {
          model: cfg.model,
          modelTaskType: cfg.modelTaskType || 'main',
          reasoningEffort: cfg.reasoningEffort || null,
          compacted: compactionCount,
          contextTrims: contextTrimCount,
          contextTrimmedChars,
          overflowRecoveries,
        });
      } catch {}
    }
    return { ok: true, summary };
  };
  try {
    if (cfg.taskAcceptanceRunner) { await cfg.taskAcceptanceRunner.initialize(signal); totalToolCalls = cfg.taskAcceptanceRunner.calls; }
    for (let iter = 0; iter < maxToolIterations; iter++) {
      loopIterations = iter + 1;
      roundCompressionSkips.clear();
      turnContent = '';
      turnReasoning = '';
      if (signal && signal.aborted) {
        const outcome = finalizeState({ aborted: true }, 'aborted');
        onDelta && onDelta({ kind: 'stopped' });
        return { content, reasoning, toolCalls: allToolCalls, usage, aborted: true, state: outcome.state, outcome, iterations: modelTurns };
      }
      const turnActor = {
        taskId: tools && tools.context && typeof tools.context.taskId === 'function' ? tools.context.taskId() : '',
        role: tools && tools.context && typeof tools.context.role === 'function' ? tools.context.role() : 'supervisor',
      };
      const archived = await resultArchive.reclaim(messages, tools?.registry, signal);
      if (archived.archived || archived.failed) emitTrace({ kind: 'tool_result_archive', turnId: iter, ...archived });
      /**
       * ① P1-4（审计 §4）：**先 compact，再做不可逆硬裁剪**。
       *
       * 硬裁剪把旧的工具结果正文换成占位符 —— 这一步**不可逆**，而且一旦发生，语义压缩看到的
       * 就已经是占位符而不是原始正文（摘要质量直接受影响，审计点名的就是这个时序）。
       * 所以在动手裁之前**先探一次**「这一轮到底会不会丢正文」（`contextBudget.planTrim` 是纯函数，
       * 零成本、不改消息）：会丢就先做语义压缩；压缩成功 → 历史已被摘要替换，通常就没得丢了；
       * 压缩失败 / 不可用 / 不划算（ROI 门：只剩一轮就别付这笔钱）→ 才真的换占位符，
       * 并把 `lastTrimStats` 留给下一轮再试一次压缩（原有的补救路径不变）。
       */
      let preTrimWouldDrop = 0;
      if (contextTrimEnabled) {
        try {
          preTrimWouldDrop = contextBudget.planTrim(messages, {
            maxChars: contextMaxChars,
            keepRecent: contextKeepRecent,
            minResultChars: contextMinResultChars,
            hardKeepRecent: contextHardKeepRecent,
          }).plan.length;
        } catch {
          preTrimWouldDrop = 0; // 探测失败不该拦住主流程：退回原来的顺序（压缩在②之前那次调用里已经试过）
        }
      }
      // ② 语义压缩（照 Codex CLI）：窗口逼近上限 / 这一轮硬裁剪会丢正文 / 上一轮已被迫硬裁剪
      //    → 用交接摘要替换「助手长文 + 工具结果」，保留 system 与人的轮次。
      if (compactionEnabled) {
        const budgetPlan = planBudgetCompaction({ cfg, messages,
          tools: typeof tools?.registry?.toOpenAiTools === 'function' ? tools.registry.toOpenAiTools() : null,
          roundsLeft: maxToolIterations - iter, attempted: budgetCompactionAttempted });
        if (budgetPlan.snapshot) emitTrace({ kind: 'request_budget_plan', turnId: iter, ...budgetPlan.snapshot, reason: budgetPlan.reason });
        if (budgetPlan.needed) {
          budgetCompactionAttempted = true;
          const result = await runCompactionStep(iter, { force: true, trigger: 'run-budget' });
          const afterPlan = planBudgetCompaction({ cfg, messages,
            tools: typeof tools?.registry?.toOpenAiTools === 'function' ? tools.registry.toOpenAiTools() : null,
            roundsLeft: maxToolIterations - iter, attempted: true });
          emitTrace({ kind: 'budget_compaction_result', turnId: iter, ok: result?.ok === true,
            budget: afterPlan.snapshot });
        } else {
          await runCompactionStep(iter, preTrimWouldDrop > 0 ? { beforeTrim: true, trigger: 'before-trim' } : undefined);
        }
      }
      signal?.throwIfAborted();
      // ③ 上下文预算（第 1 项）：请求前裁剪。只把**旧的、超大的工具结果正文**换成占位符，
      // 消息条数/角色顺序/tool_calls↔tool_call_id 配对一概不动 —— 不制造「孤立 tool 消息」。
      if (contextTrimEnabled) {
        const trim = contextBudget.applyTrim(messages, {
          maxChars: contextMaxChars,
          keepRecent: contextKeepRecent,
          minResultChars: contextMinResultChars,
          hardKeepRecent: contextHardKeepRecent,
        });
        // 交给下一轮：被迫裁剪 = 「占位符已经换不出质量」，下次先做语义压缩
        lastTrimStats = trim;
        if (trim.trimmed > 0) {
          contextTrimCount += trim.trimmed;
          contextTrimmedChars += trim.before - trim.after;
          emitTrace({
            kind: 'context_trim',
            turnId: iter,
            trimmed: trim.trimmed,
            before: trim.before,
            after: trim.after,
            maxChars: trim.maxChars,
            tier: trim.tier,
            overBudget: trim.overBudget,
            tools: trim.details.map((item) => item.toolName + ':' + item.originalChars),
          });
          onDelta && onDelta({ kind: 'context_trim', trimmed: trim.trimmed, before: trim.before, after: trim.after, tier: trim.tier, overBudget: trim.overBudget });
        }
      }
      /**
       * 超窗预检：
       *   ① 输入本身就超窗 → 别发出去吃 400，如实报 CONTEXT_OVERFLOW 并给出可执行的出路。
       *      **只认可信窗口**（preflightWindow）：用户声明/配置的，或供应商报错里明确报出的。
       *      由估算推导出来的下界不参与拒发 —— 它会把本来能发的请求在该进程内永久挡死。
       *   ② 输入能装下、只是把输出预算挤掉了 → **缩小 max_tokens 继续发**（这比拒发好得多：
       *      用户仍然拿到回答，只是短一点），并把这次收缩如实上报。收缩可以用更保守的
       *      shrinkWindow（缩短回答无损），但纯兜底值仍然不参与。
       */
      /**
       * 用户插话（steering）—— 运行中也能纠偏，不必整停重来。
       *
       * 注入点刻意选在**压缩/硬裁剪之后、超窗预检之前**：
       *   - 压缩会把机器注入的 user 消息丢掉（`isMachineInjection`），插话若放在压缩前就有被吞掉的风险；
       *   - 放在预检前，插话的 token 会被算进本轮估算，超窗时能如实拒发而不是发出去吃 400。
       * 每轮只 drain 一次：同一条插话只进一次请求体（判据见 scripts/core/agent-steering-test.cjs）。
       */
      if (steering && typeof steering.drain === 'function') {
        let pendingSteers = [];
        try {
          pendingSteers = steering.drain() || [];
        } catch (error) {
          emitTrace({ kind: 'steer_error', turnId: iter, error: String((error && error.message) || error) });
        }
        for (const raw of Array.isArray(pendingSteers) ? pendingSteers : []) {
          const text = String(raw == null ? '' : raw).trim();
          if (!text) continue;
          const content = '【用户插话】' + text.slice(0, 2000);
          messages.push({ role: 'user', content });
          groundingTask += '\n' + content;
          steerCount += 1;
          emitTrace({ kind: 'steer_injected', turnId: iter, chars: content.length });
          onDelta && onDelta({ kind: 'steer_injected', turnId: iter, text: text.slice(0, 200) });
        }
      }
      let turnMaxTokens = Number(cfg.maxTokens) || 0;
      /**
       * P2-1：按阶段定档。只在本 run 有工具面、且用户显式给了 max_tokens 时生效
       * （没有工具面的纯对话、或没配 max_tokens 的场景保持原样 —— 不给「不涉及工具的场景」加新行为）。
       * 口径：上一轮**没有**工具调用（正在交付/续写）→ final 档；否则（在选工具）→ tool 档。
       * 两档都只能**往下压**，永远不会超过用户配的 max_tokens。
       */
      if (limits.outputTiers && turnMaxTokens > 0 && tools && tools.registry) {
        // 上一轮**调过工具** → 这一轮是在「选工具」（tool 档）；否则（首轮 / 交付 / 续写）→ final 档。
        // 首轮给 final 档是有意的：那时还不知道要干什么，压缩首轮等于给「一次问清」的场景加截断风险。
        const tierBudget = lastResponseHadToolCalls ? limits.toolMaxTokens : limits.finalMaxTokens;
        const wanted = Math.max(Number(outputBudgetOverride) || 0, Number(tierBudget) || 0);
        const capped = wanted > 0 ? Math.min(turnMaxTokens, wanted) : turnMaxTokens;
        if (capped !== turnMaxTokens) {
          emitTrace({
            kind: 'output_budget_tier',
            turnId: iter,
            tier: lastResponseHadToolCalls ? 'tool' : 'final',
            from: turnMaxTokens,
            to: capped,
          });
          turnMaxTokens = capped;
        }
      }
      if (preflightWindow > 0 || shrinkWindow > 0) {
        const preflightTools = tools && tools.registry && typeof tools.registry.toOpenAiTools === 'function' ? tools.registry.toOpenAiTools() : null;
        const estimate = compactionLib.estimateTokens(messages, preflightTools);
        if (preflightWindow > 0 && estimate > preflightWindow) {
          const error =
            '上下文超窗：本次请求的输入本身估算 ' +
            estimate +
            ' tokens，已超过模型窗口 ' +
            preflightWindow +
            '，直接发送会被供应商拒掉（此前的表现就是「回答写一半就断」）。可执行：' +
            '① 开一个新会话（最快）；② 调小 agent.compact.keep_user_total_chars / keep_user_max_chars，让压缩保留更少；' +
            '③ 若模型管理里的上下文窗口值与供应商实际不符（标称大、实际小），改成真实值；④ 换窗口更大的模型。';
          emitTrace({ kind: 'context_overflow', turnId: iter, phase: 'preflight', tokens: estimate, reserve: turnMaxTokens, window: preflightWindow });
          onDelta && onDelta({ kind: 'context_overflow', phase: 'preflight', tokens: estimate, reserve: turnMaxTokens, window: preflightWindow });
          const outcome = finalizeState({ error, stopReason: 'context_overflow' }, 'context_overflow');
          onDelta && onDelta({ kind: 'error', error });
          return {
            content,
            reasoning,
            toolCalls: allToolCalls,
            usage,
            error,
            stopReason: 'context_overflow',
            state: outcome.state,
            outcome,
            iterations: modelTurns,
            contextTrims: contextTrimCount,
            contextTrimmedChars,
            compacted: compactionCount,
            overflowRecoveries,
          };
        }
        if (shrinkWindow > 0 && estimate + turnMaxTokens > shrinkWindow) {
          const capped = Math.max(1024, shrinkWindow - estimate - 64);
          emitTrace({
            kind: 'max_tokens_capped',
            turnId: iter,
            from: turnMaxTokens,
            to: capped,
            tokens: estimate,
            window: shrinkWindow,
          });
          onDelta &&
            onDelta({ kind: 'max_tokens_capped', from: turnMaxTokens, to: capped, tokens: estimate, window: shrinkWindow });
          turnMaxTokens = capped;
        }
      }
      /** 所有机器提示都在压缩之后注入；计划提示有独立前缀/替换游标，不受进度提醒配置影响。 */
      if (typeof cfg.subagentBudgetState === 'function') {
        const state = cfg.subagentBudgetState(tools && tools.context);
        require('./schedulingSettings.cjs').updateBudgetNote(messages, state);
      }
      const planForNote = readRunPlan(traceProjectRoot(), cfg);
      const planStamp = runPlanVersion(planForNote);
      const planChanged = !!planStamp && planStamp !== lastPlanStamp;
      if (progressEvery > 0 && iter > 0 && iter % progressEvery === 0) {
        const note = buildProgressNote({
          iteration: iter + 1,
          maxIterations: maxToolIterations,
          toolCallsUsed: allToolCalls.length,
          toolCallBudget: maxTotalToolCalls,
          changedFiles: changedFilesFromToolCalls(allToolCalls),
          failures: allToolCalls.filter((call) => call && call.ok === false).map((call) => ({ tool: call.name, code: (call.failure && call.failure.code) || '' })),
          tokensUsed: totalTokens,
          tokenBudget: progressTokenBudget,
        });
        const previous = messages.findIndex(
          (msg) => msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(PROGRESS_NOTE_PREFIX)
        );
        if (previous >= 0) messages[previous] = { role: 'user', content: note };
        else messages.push({ role: 'user', content: note });
        emitTrace({ kind: 'progress_check', turnId: iter, iteration: iter + 1, maxIterations: maxToolIterations, toolCalls: allToolCalls.length });
        onDelta && onDelta({ kind: 'progress_check', iteration: iter + 1, maxIterations: maxToolIterations, toolCalls: allToolCalls.length });
      }

      if (planChanged) {
        const note = buildPlanNote(planForNote);
        if (note) {
          const previous = messages.findIndex(
            (msg) => msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(PLAN_NOTE_PREFIX)
          );
          if (previous >= 0) messages[previous] = { role: 'user', content: note };
          else messages.push({ role: 'user', content: note });
          lastPlanStamp = planStamp;
          emitTrace({ kind: 'plan_prompt', turnId: iter, items: planForNote.items.length, updatedAt: planForNote.updatedAt || null, planVersion: planStamp });
        }
      }

      /**
       * 计划卡（对照文档 §5 #2 的「UI 可见」）：计划一变就把**结构化计划**发给界面。
       * 与进度提示的注入解耦 —— progressEvery=0（不注入进度提示）时界面照样能看到计划。
       */
      const planForUi = readRunPlan(traceProjectRoot(), cfg);
      const planUiStamp = runPlanVersion(planForUi);
      if (planForUi && planUiStamp && planUiStamp !== lastPlanUiStamp) {
        lastPlanUiStamp = planUiStamp;
        emitTrace({ kind: 'plan_card', turnId: iter, items: Array.isArray(planForUi.items) ? planForUi.items.length : 0, updatedAt: planForUi.updatedAt || null, planVersion: planUiStamp });
        onDelta &&
          onDelta({
            kind: 'plan',
            runId: (cfg && cfg.costRunId) || null,
            sessionId: (cfg && cfg.planSessionId) || null,
            updatedAt: planForUi.updatedAt ? String(planForUi.updatedAt) : null,
            planVersion: planUiStamp,
            items: Array.isArray(planForUi.items) ? planForUi.items : [],
          });
      }
      /**
       * 这里**不再**自己拼请求体（唯一来源 = 协议层，见 chatBody）：payload 只保留
       * 「OpenAI 形状的工具面」供 token 估算与 run 事件留痕，别拿它当实际发出的报文。
       */
      const payload = { tools: tools && tools.registry ? tools.registry.toOpenAiTools() : null };
      noProgressGuard.update(messages, allToolCalls, steerCount + '|' + lastPlanStamp);
      require('./workingState.cjs').update({ enabled: limits.workingState === true, root: traceProjectRoot(), runId: cfg.costRunId, messages, records: allToolCalls, plan: planForNote, verification: codeVerifier?.freshness(), emitTrace });
      require('./toolResultReferences.cjs').repair(messages);
      const handoff = await require('./budgetWrapUp.cjs').finishBudgetWork({ cfg: { ...cfg, maxTokens: turnMaxTokens || cfg.maxTokens }, messages, tools: payload.tools, toolCalls: allToolCalls,
        verification: codeVerifier?.freshness(), signal, chat: chatCompletion, makeWrapUp: buildLimitWrapUp, emitTrace, onDelta,
        finalizeState, modelTurns, checkpoint: tools?.context?.checkpointMessages?.bind(tools.context) });
      if (handoff) {
        const { handoffUsage, handoffResponse, ...result } = handoff;
        if (handoffResponse?.usage) recordCost(cfg, { kind: 'budget-wrapup', model: handoffResponse.actualModel || cfg.model, usage: handoffUsage, attempt: handoffResponse.httpAttempts });
        return { ...result, reasoning, usage: mergeUsage(usage, handoffUsage), contextTrims: contextTrimCount, contextTrimmedChars, compacted: compactionCount };
      }
      const turnStartedAt = Date.now();
      const onEvent = (ev) => {
        if (ev.kind === 'model_route' || ev.kind === 'model_fallback' || ev.kind === 'model_retry') {
          emitTrace({ ...ev, turnId: iter });
          onDelta && onDelta(ev);
          return;
        }
        if (ev.kind === 'stream_restart') {
          // 流中途断了、这一轮要整轮重发：**本轮的**累加与界面上的半截输出都必须作废，
          // 否则重发出来的完整回答会接在半截后面（用户看到两遍开头）。
          content = content.slice(0, Math.max(0, content.length - turnContent.length));
          reasoning = reasoning.slice(0, Math.max(0, reasoning.length - turnReasoning.length));
          turnContent = '';
          turnReasoning = '';
          streamRestarts += 1;
          emitTrace({
            kind: 'stream_restart',
            turnId: iter,
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            reason: ev.reason,
            receivedChars: ev.receivedChars,
          });
          onDelta && onDelta({ kind: 'content_reset', attempt: ev.attempt, maxAttempts: ev.maxAttempts, reason: ev.reason });
          return;
        }
        if (ev.kind === 'reasoning') {
          reasoning += ev.text;
          turnReasoning += ev.text;
          onDelta && onDelta({ kind: 'reasoning', text: ev.text });
        } else if (ev.kind === 'content') {
          content += ev.text;
          turnContent += ev.text;
          if (!strictDelivery) onDelta && onDelta({ kind: 'content', text: ev.text });
        } else if (ev.kind === 'tool') {
          onDelta && onDelta({ kind: 'tool', toolCalls: ev.toolCalls });
        }
      };
      /**
       * 发这一轮请求。供应商**真报了超窗**（400）时不只是冒错，而是自救一次：
       *   ① 把该模型的保守窗口下限记进进程内账本（下次压缩线按它算，不再等声明值）；
       *   ② **同时**把本轮输出预算压进这个窗口 —— 400 有两种成因：输入太大，或
       *      「输入 + max_tokens 输出预留」超出窗口（实测 DeepSeek 会回
       *      "… you requested N tokens (X in the messages, Y in the completion)"）。
       *      只压历史不压输出预算，对第二种成因等于没救（重发还是同一个 400）。
       *   ③ 强制一次语义压缩（越过阈值判定），然后用压缩后的历史重发。
       * 只救一次：压完还超说明剩下的东西本身超窗 —— 那种情况该走预检/开新会话，硬重试只会烧钱。
       */
      const buildTurnCfg = () => {
        require('./toolResultReferences.cjs').repair(messages);
        return turnMaxTokens === Number(cfg.maxTokens) ? cfg : { ...cfg, maxTokens: turnMaxTokens };
      };
      const sendTurn = async () => {
        try {
          return await chatCompletionStream(buildTurnCfg(), messages, onEvent, { signal, timeoutMs: turnTimeoutMs, tools: payload.tools || undefined });
        } catch (error) {
          const overflow = classifyContextOverflow(error);
          if (!overflow || !compactionEnabled || overflowRecoveries >= maxOverflowRecoveries) throw error;
          overflowRecoveries += 1;
          const tokens = compactionLib.estimateTokens(messages, payload.tools);
          // 优先采用报错里明确写着的真实窗口（可信、可用于预检）；拿不到才退回估算下界。
          const window = noteContextOverflow(cfg, { tokens, providerMessage: overflow.message });
          const windowSource = isContextWindowOverrideAuthoritative(cfg) ? 'provider' : 'estimated';
          emitTrace({
            kind: 'context_overflow',
            turnId: iter,
            phase: 'provider-rejected',
            tokens,
            window,
            windowSource,
            status: overflow.status,
            maxTokens: turnMaxTokens,
            message: overflow.message.slice(0, 300),
          });
          onDelta &&
            onDelta({
              kind: 'context_overflow',
              phase: 'recovering',
              tokens,
              window,
              maxTokens: turnMaxTokens,
              providerMessage: overflow.message.slice(0, 300),
            });
          const compacted = await runCompactionStep(iter, { force: true, trigger: 'provider-rejected' });
          if (!compacted || compacted.ok !== true) throw error; // 压不动就别装作能救，原样抛出真因
          // 输出预算用**压缩之后**的输入重算：这时输入已经小了，不该把输出也一起饿死
          const tokensAfter = compactionLib.estimateTokens(messages, payload.tools);
          const fit = Math.max(1024, window - tokensAfter - 64);
          const shrankOutput = fit < turnMaxTokens;
          if (shrankOutput) turnMaxTokens = fit;
          emitTrace({ kind: 'context_overflow_retry', turnId: iter, tokens, tokensAfter, maxTokens: turnMaxTokens, shrankOutput });
          // The new request still consumes a retry credit after the provider's
          // 400, even though it begins a fresh stream with compacted messages.
          return chatCompletionStream(buildTurnCfg(), messages, onEvent,
            { signal, timeoutMs: turnTimeoutMs, tools: payload.tools || undefined, retryOffset: 1 });
        }
      };
      const res = await sendTurn();
      if (res && res.traceContext && tools && tools.context) {
        // Tool calls belong under the model span that produced them. The
        // context object is intentionally mutable only inside the trusted
        // main loop; tool-facing execution contexts receive a snapshot.
        tools.context.traceContextValue = res.traceContext;
      }
      modelTurns += 1;
      /** 只在模型请求成功返回后计数；允许迭代上限不代表这份摘要实际被后续请求复用。 */
      const realizedCompressionCarries = [];
      for (const carry of compressedCarryEntries) {
        if (carry.active === false) continue;
        const carriedMessage = messages.find(
          (msg) => msg && msg.role === 'tool' && msg.tool_call_id === carry.toolCallId,
        );
        if (!carriedMessage || typeof carriedMessage.content !== 'string' || !carriedMessage.content.startsWith(carry.summary)) {
          carry.active = false;
          continue;
        }
        carry.carries += 1;
        const stat = compressionStats.get(carry.toolName);
        if (stat) {
          stat.realizedSavedTokens += carry.savedTokens;
          stat.realizedCarryRequests += 1;
          stat.costKnown = stat.costKnown && carry.costKnown;
          stat.netTokensSaved = stat.costKnown ? stat.realizedSavedTokens - stat.costTokens : null;
          stat.netTokensImmediate = stat.costKnown ? stat.savedTokens - stat.costTokens : null;
          carry.record.netTokensSaved = stat.netTokensSaved == null ? null : Math.round(stat.netTokensSaved);
          carry.record.realizedCarryRequests = carry.carries;
          carry.record.realizedSavedTokens = Math.round(carry.savedTokens * carry.carries);
        }
        realizedCompressionCarries.push(carry.toolName);
      }
      if (realizedCompressionCarries.length) {
        const compressionTotals = [...compressionStats.values()].reduce(
          (totals, stat) => ({
            saved: totals.saved + (Number(stat.realizedSavedTokens) || 0),
            carries: totals.carries + (Number(stat.realizedCarryRequests) || 0),
            net: totals.net + (Number(stat.netTokensSaved) || 0),
          }),
          { saved: 0, carries: 0, net: 0 },
        );
        emitTrace({
          kind: 'compression_realization',
          turnId: iter,
          items: realizedCompressionCarries.length,
          tools: realizedCompressionCarries,
          realizedSavedTokens: compressionTotals.saved,
          realizedCarryRequests: compressionTotals.carries,
          costKnown: [...compressionStats.values()].every((stat) => stat.costKnown !== false),
          netTokensSaved: compressionTotals.net,
        });
      }
      // 本轮结束：本轮缓冲交还（content/reasoning 里已经含它，不需要再留着回滚）
      turnContent = '';
      turnReasoning = '';
      /**
       * 流内异常必须被消费（#12）。streamAccumulator 早就会把「HTTP 200 的流里下发了 error 对象」
       * 记成 `in-stream-error`，但主循环此前**从不读** `res.anomalies` —— 于是一个只有半截回答、
       * 甚至完全空白的「成功」回合会被当 COMPLETED 交付：没有报错、没有落 run 事件、
       * 用户与排障者都拿不到任何归因线索（正是「回答写一半就断」的残留形态之一）。
       */
      const streamAnomalies = Array.isArray(res && res.anomalies) ? res.anomalies : [];
      if (streamAnomalies.length) {
        emitTrace({
          kind: 'stream_anomaly',
          turnId: iter,
          count: streamAnomalies.length,
          types: streamAnomalies.map((a) => String((a && a.type) || '')).slice(0, 8),
        });
        const fatal = streamAnomalies.find((a) => a && FATAL_STREAM_ANOMALIES.has(a.type));
        if (fatal) {
          // 供应商报错或分片损坏后，即使已有正文/完整形状的调用也不能执行工具。
          const providerError = fatal.type === 'in-stream-error';
          const detail = providerError ? String(fatal.detail || '').slice(0, 200) : '';
          const error = providerError
            ? '模型流内错误：供应商在 HTTP 200 的流里下发了 error' + (detail ? '（' + detail + '）' : '')
            : '模型流分片损坏（' + fatal.type + '），本轮未执行工具。';
          const outcome = finalizeState({ error, stopReason: 'stream_error' }, 'stream_error');
          emitTrace({ kind: 'stream_error', turnId: iter, type: fatal.type, detail });
          onDelta && onDelta({ kind: 'error', error });
          return {
            content,
            reasoning,
            toolCalls: allToolCalls,
            usage,
            error,
            stopReason: 'stream_error',
            state: outcome.state,
            outcome,
            iterations: modelTurns,
            contextTrims: contextTrimCount,
            contextTrimmedChars,
            compacted: compactionCount,
            overflowRecoveries,
          };
        }
      }
      if (res.usage) {
        usage = mergeUsage(usage, res.usage);
        /**
         * P2-2：主请求内部构成（哪一层在烧 token）。
         * 只测量：把 system 段落 + 历史按角色 + 工具 schema + 工具投影累加器一起算出来挂到账本 meta 上。
         * `cacheMiss` 由**供应商报的**命中/未命中推（没有数据时为 false —— 不编造 miss）。
         */
        let attribution = null;
        try {
          const usageParts = costLedgerLib.tokenParts(res.usage);
          const systemContent = messages[0] && messages[0].role === 'system' && typeof messages[0].content === 'string'
            ? messages[0].content
            : '';
          const sections = systemContent ? splitPromptSections(systemContent) : [];
          const schemaInfo = tools && tools.registry && typeof tools.registry.schemaInfo === 'function' ? tools.registry.schemaInfo() : null;
          attribution = costAttribution.attribute({
            sections,
            messages: messages.slice(systemContent ? 1 : 0),
            tools: payload && payload.tools,
            toolSchemaTokens: schemaInfo ? schemaInfo.tokens : null,
            toolProjection,
            compressionStats,
            cachedTokens: usageParts.cached,
            missTokens: usageParts.miss,
            cacheMiss: usageParts.miss > 0 && usageParts.cached === 0,
            previousSections: lastAttributionSections,
          });
          if (sections.length) lastAttributionSections = sections;
        } catch {
          attribution = null; // 归因失败绝不影响主流程
        }
        // 记账口径由调用方决定：子代理用自己的 costKind='subagent' 逐轮记，
        // 外层**不再**额外汇总记一次 —— 否则同一个子代理会被记两遍（账本与成本告警约 2 倍失真）。
        recordCost(cfg, {
          kind: (cfg && cfg.costKind) || 'main',
          model: res.actualModel || cfg.model,
          usage: res.usage,
          attempt: res.httpAttempts,
          latencyMs: Date.now() - turnStartedAt,
          runId: cfg.costRunId,
          traceContext: res.requestTraceContext || res.traceContext || cfg.traceContext || null,
          attemptId: res.httpAttempts ? 'http#' + String(res.httpAttempts) : null,
          meta: { ...(attribution ? { attribution } : {}), perAttempt: true },
        });
        totalTokens = Number(usage.total_tokens) || totalTokens;
        const maxTotalTokens = Number(cfg && cfg.limits && cfg.limits.maxTotalTokens) || 250000;
        if (totalTokens > maxTotalTokens) {
          const error = '已达到本轮 Agent token 预算（' + maxTotalTokens + '），已停止继续调用模型。';
          onDelta && onDelta({ kind: 'error', error });
          return { content, reasoning, toolCalls: allToolCalls, usage, error, iterations: modelTurns };
        }
      }

      const toolCalls = res.toolCalls || [];
      lastResponseHadToolCalls = toolCalls.length > 0;
      const finishReason = res.finishReason || null;
      if (finishReason) lastFinishReason = finishReason;
      // 被 max_tokens 截断（finish_reason=length）且没有任何工具调用：不能把半截回答当最终答案，
      // 也不能无限补问 —— 最多补 maxTruncationNudges 次（agent.truncation_nudges，出厂 4），
      // 其余交给 MAX_TOOL_ITERATIONS 兜底。
      // 提示语必须是「从断点接着写」：早先写的是「把回复拆短：只给结论」——那等于让模型
      // 在被截断之后主动丢信息，用户拿到的是越缩越水的半份交付。
      /**
       * P2-1：被 max_tokens 截断时，先分清「有正文」还是「正文为空」：
       *   - 有正文 → 从断点接着写（既有行为，只补 maxTruncationNudges 次）；
       *   - **正文为空** → 「接着写」是没意义的（没有断点可接），说明额度被 reasoning/空转吃掉了。
       *     这时**加预算重试一次**同一轮（不动 messages），而不是让模型从零再写一遍半截。
       *     只在预算是被阶段档压下来的时候才可能抬得动（永远不超过用户配的 max_tokens）。
       */
      if (!toolCalls.length && finishReason === 'length' && !String(res.content || '').trim()) {
        const bumpTo = Math.min(
          Number(cfg.maxTokens) || 0,
          Math.max(turnMaxTokens * 2, Number(limits.finalMaxTokens) || 0),
        );
        if (truncationBumps < Number(limits.truncationBumps) && bumpTo > turnMaxTokens) {
          truncationBumps += 1;
          outputBudgetOverride = bumpTo;
          emitTrace({ kind: 'truncation_budget_bump', turnId: iter, from: turnMaxTokens, to: bumpTo, count: truncationBumps });
          onDelta && onDelta({ kind: 'truncated', count: truncationBumps, max: Number(limits.truncationBumps), finishReason, continuing: false, budgetBumped: true });
          continue;
        }
      }
      if (!toolCalls.length && finishReason === 'length' && truncationNudges < maxTruncationNudges) {
        truncationNudges += 1;
        messages.push({ role: 'assistant', content: String(res.content || '') });
        messages.push({
          role: 'user',
          content:
            '【系统提示】上一轮输出触到长度上限被截断（finish_reason=length）。请**直接从断点接着写**：' +
            '不要重新开头、不要重复已经输出过的内容，也不要为了缩短篇幅丢信息。',
        });
        emitTrace({ kind: 'truncation_nudge', turnId: iter, finishReason, count: truncationNudges });
        onDelta && onDelta({ kind: 'truncated', count: truncationNudges, max: maxTruncationNudges, finishReason, continuing: true });
        continue;
      }
      if (tools && tools.registry && toolCalls.length) {
        codeVerifier?.beginRound(toolCalls, hooksCfg.enabled);
        /** @type {Array<{toolName: string, content: string, contentTokens: number, record: any, cacheKey: string|null, messageIndex: number, toolCallId: string, expectedReuseRounds?: number}>} */
        const pendingCompression = [];
        /** @type {Array<{record: any, messageIndex: number}>} */
        const roundObservations = [];
        // 注意：content 已在 onEvent 流式累加，此处不能重复累加（否则每轮带内容的工具调用会重复叠加）
        assignCallIds(toolCalls, iter);
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: toolCalls.map((tc) => ({
            id: tc.callId,
            type: 'function',
            function: { name: tc.name, arguments: tc.args || '{}' },
          })),
        });
        let capped = false;
        let failedAny = false;
        transitionState(STATES.WAITING_TOOL, 'tool_calls:' + toolCalls.length);
        // S6：先给这一轮里「只读且互不冲突」的调用并发启动执行（默认关闭时是空操作）。
        // 只启动、不等待 —— 下面的 for 仍按原顺序 await，因此 record / messages / 幂等账本 /
        // 检查点的顺序与串行执行时逐字节相同（写操作、需确认、参数不完整的调用一律不预启动）。
        const primed = toolScheduler.enabled
          ? toolScheduler.prime(
              toolCalls.map((tc, index) => ({
                callId: tc.callId || tc.id || 'call_' + iter + '_' + (totalToolCalls + index + 1),
                name: tc.name,
                argsText: tc.args,
                argsValid: tc.argsValid,
              })),
              {
                signal,
                turnId: iter,
                budget: Math.max(0, maxTotalToolCalls - totalToolCalls),
                descriptorOf: (name) => (tools.registry && typeof tools.registry.descriptorOf === 'function' ? tools.registry.descriptorOf(name) : null),
                isMalformed: (item) => {
                  const parsedArgs = parseToolArgs(item.argsText);
                  const rawText = String(item.argsText || '').trim();
                  return finishReason === 'length' || item.argsValid === false ||
                    (rawText !== '' && rawText !== '{}' && Object.keys(parsedArgs).length === 0);
                },
                execute: (item, execOptions) => {
                  if (tools.context && typeof tools.context.setToolEvidence === 'function') tools.context.setToolEvidence(allToolCalls);
                  return tools.registry.execute(item.name, parseToolArgs(item.argsText), tools.context, execOptions);
                },
                trace: (event) => emitTrace(Object.assign({ turnId: iter }, event)),
              },
            )
          : null;
        for (const tc of toolCalls) {
          if (signal && signal.aborted) {
            const outcome = finalizeState({ aborted: true }, 'aborted');
            onDelta && onDelta({ kind: 'stopped' });
            return { content, reasoning, toolCalls: allToolCalls, usage, aborted: true, state: outcome.state, outcome, iterations: modelTurns };
          }
          if (totalToolCalls >= maxTotalToolCalls) {
            capped = true;
            break;
          }
          totalToolCalls++;
          const t0 = Date.now();
          const args = parseToolArgs(tc.args);
          const rawArgs = (tc.args || '').trim();
          const malformed = tc.argsValid === false || (rawArgs !== '' && rawArgs !== '{}' && Object.keys(args).length === 0);
          const truncatedToolCall = finishReason === 'length';
          // callId 统一取自 assignCallIds：assistant 声明的 id 与这条 tool 消息的 tool_call_id 必须一致
          const callId = tc.callId || tc.id || ('call_' + iter + '_' + totalToolCalls);
          // 副作用幂等 + 检查点：写操作先登记意图，中断后续跑时凭账本跳过已提交的写操作
          let sideEffectToken = null;
          let sideEffectGuardError = null;
          let deduped = false;
          let dedupReason = '';
          if (!malformed && !truncatedToolCall && tools.context && typeof tools.context.beginSideEffect === 'function') {
            try {
              // 把「工具自报重复执行安全」带下去：账本对那些**无法核对目标状态**的写
              // （参数里没有 path，例如 save_project：键恒同、但画布可能早就变了）
              // 必须真做一次，不能拿「已提交」当成功交付。
              const descriptor =
                tools.registry && typeof tools.registry.descriptorOf === 'function' ? tools.registry.descriptorOf(tc.name) : null;
              const guard = await tools.context.beginSideEffect(tc.name, args, {
                idempotent: !!(descriptor && descriptor.idempotent === true),
              });
              if (guard && guard.skip) {
                deduped = true;
                sideEffectToken = null;
                // 账本给出的是「谁提交的 / 谁在重复」的可归因文案（S9），不再由主循环编一句
                // 「上一次中断前已提交」——那条文案在父子代理共用幂等域时会与事实不符。
                dedupReason = String(guard.reason || '');
                if (typeof tools.context.checkpoint === 'function') {
                  tools.context.checkpoint('tool_intent', { callId, tool: tc.name, argsDigest: require('./sideEffects.cjs').digest(args), effect: guard.effect, idemKey: guard.idemKey, actor: turnActor });
                  tools.context.checkpoint('tool_commit', { callId, tool: tc.name, ok: true, idemKey: guard.idemKey, effect: guard.effect, resultDigest: 'skipped-by-ledger', actor: turnActor });
                }
              } else if (guard) {
                sideEffectToken = { ...guard, tool: tc.name, callId };
                if (typeof tools.context.checkpoint === 'function') {
                  tools.context.checkpoint('tool_intent', { callId, tool: tc.name, argsDigest: guard.argsDigest || require('./sideEffects.cjs').digest(args), effect: guard.effect, idemKey: guard.idemKey, actor: turnActor });
                }
              }
            } catch (error) {
              sideEffectGuardError = error;
            }
          }
          // JSON 不完整与整轮 length 截断都不能执行；后者即使 JSON 恰好完整，也可能缺后续调用。
          let result;
          let repeated = false;
          if (sideEffectGuardError) {
            result = require('./tools/result.cjs').AgentToolResult.failure(
              sideEffectGuardError.code === 'EFFECT_UNKNOWN' ? 'EFFECT_UNKNOWN' : 'SYSTEM_ERROR',
              '副作用状态检查未通过，本次未执行 ' + tc.name + '：' + String(sideEffectGuardError.message || sideEffectGuardError),
              { executed: false, sideEffectStatus: sideEffectGuardError.code === 'EFFECT_UNKNOWN' ? 'unknown' : 'guard-failed' },
              { retryable: false },
            );
          } else if (deduped) {
            // 幂等去重：该写操作已提交过，直接复用结论，绝不重复产生副作用。
            // 文案来自账本（含行为者归因），失败时退回中性描述，不编造「上次中断前」这类事实。
            result = require('./tools/result.cjs').AgentToolResult.ok(
              '（幂等去重）' + (dedupReason || '该写操作已在本次运行中提交过，本次跳过执行。'),
              { skipped: true, dedupedBy: 'side-effect-ledger' }
            );
            repeated = true;
          }
          const cacheKey = !deduped && CACHEABLE_TOOLS.has(tc.name) ? tc.name + '\u0000' + canonicalArgs(tc.args) : null;
          const cacheVersion = cacheKey ? await cacheVersions.version(tc.name, signal, args) : null;
          if (sideEffectGuardError || deduped) {
            // 已在上方构造结果，跳过执行
          } else if (malformed) {
            // **拒绝执行**：拿解析失败后的 {} 去调工具，会让写操作在没有参数的情况下真的执行
            // （例如 workbench_edit / write_file 拿到空参）。改为把错误回灌给模型让它重写参数。
            result = require('./tools/result.cjs').AgentToolResult.error(
              '参数不是完整 JSON，本次未执行 ' + tc.name + '（可能是 max_tokens 截断或引号转义错误）。' +
                '请用更短的参数重新调用；长内容先写文件再用路径引用。',
              { code: 'ARG_INVALID_JSON', tool: tc.name, finishReason: finishReason || null, argsLength: rawArgs.length }
            );
          } else if (truncatedToolCall) {
            result = require('./tools/result.cjs').AgentToolResult.error(
              '模型输出触及长度上限，本轮工具调用未确认完成，未执行 ' + tc.name + '。请重新生成完整调用。',
              { code: 'TOOL_CALL_TRUNCATED', tool: tc.name, finishReason, argsLength: rawArgs.length }
            );
          } else if (cacheKey) {
            let cached = toolResultCache.get(cacheKey);
            if (cached && !await cacheVersions.valid(tc.name, args, cached, cacheVersion, signal)) {
              toolResultCache.delete(cacheKey);
              cached = null;
              emitTrace({ kind: 'tool_cache_invalidated', turnId: iter, tool: tc.name, reason: 'source-version-changed-or-unavailable' });
            }
            if (cached) {
              result = cached.result;
              repeated = true;
            } else {
              // S6：只读并行时这里直接 await 预启动的 promise（只是提前开始了，顺序不变）
              const primedPromise = primed && primed.promises ? primed.promises.get(callId) : null;
              if (tools.context && typeof tools.context.setToolEvidence === 'function') tools.context.setToolEvidence(allToolCalls);
              result = primedPromise ? await primedPromise : await tools.registry.execute(tc.name, args, tools.context, { turnId: iter, toolCallId: callId });
              // 只缓存成功结果：失败不缓存（文件/节点可能随后被创建，需允许重试时重新执行）
              if (result.ok) toolResultCache.set(cacheKey, { result, content: '', version: cacheVersion });
            }
          } else {
            const primedPromise = primed && primed.promises ? primed.promises.get(callId) : null;
            if (tools.context && typeof tools.context.setToolEvidence === 'function') tools.context.setToolEvidence(allToolCalls);
            result = primedPromise ? await primedPromise : await tools.registry.execute(tc.name, args, tools.context, { turnId: iter, toolCallId: callId });
          }
          if (signal && signal.aborted) {
            const outcome = finalizeState({ aborted: true }, 'aborted');
            onDelta && onDelta({ kind: 'stopped' });
            return { content, reasoning, toolCalls: allToolCalls, usage, aborted: true, state: outcome.state, outcome, iterations: modelTurns };
          }
          // 缓存失效按「只读白名单」判定：只要本轮执行的不是纯只读工具（execute_shell / poll_job /
          // delegate_task / 扩展与 MCP 工具 / 任何变更类工具），就整表清空，保证随后读取拿到最新状态。
          if (!CACHEABLE_TOOLS.has(tc.name)) toolResultCache.clear();
          // 副作用结算：写操作提交/失败都落账本，中断后能判断哪些写已经发生
          if (sideEffectToken && tools.context) {
            try {
              if (result.ok) await tools.context.commitSideEffect(sideEffectToken, { ok: true, result: result.text });
              else await tools.context.failSideEffect(sideEffectToken, result);
            } catch (error) {
              result = require('./tools/result.cjs').AgentToolResult.failure(
                'EFFECT_UNKNOWN',
                '工具已返回，但副作用状态无法可靠保存；请先核对真实状态，禁止自动重放：' + String(error.message || error),
                { executed: true, sideEffectStatus: 'unknown', tool: tc.name },
                { retryable: false },
              );
            }
            if (typeof tools.context.checkpoint === 'function') {
              tools.context.checkpoint('tool_commit', {
                callId,
                tool: tc.name,
                ok: result.ok,
                idemKey: sideEffectToken.idemKey,
                effect: sideEffectToken.effect,
                resultDigest: require('./sideEffects.cjs').digest(String(result.text || '').slice(0, 4000)),
                elapsedMs: Date.now() - t0,
                actor: turnActor,
              });
            }
          }
          const elapsed = Date.now() - t0;
          const record = {
            name: tc.name,
            args: tc.args || '',
            ok: result.ok,
            result: result.text,
            data: result.data,
            callId,
            actor: turnActor,
          };
          if (repeated) record.repeated = true;
          // S5：失败立即归类（工具显式声明的 failure > data.code 归一表 > timedOut/cancelled 这类结构化信号
          // > 认不出来就按最保守的 FATAL_FAILURE 并标 known:false —— 不做文本猜测）
          if (!result.ok) {
            record.failure = failures.classifyFailure(result, { tool: tc.name, toolCallId: callId, attemptId: callId + '#1' });
          } else if (result.kind === 'partial') {
            record.partial = true;
          }
          if (!result.ok) failedAny = true;
          allToolCalls.push(record);
          codeVerifier?.observe(record);
          // 组装回传上下文的内容：repeated 直接复用缓存内容（含压缩结果）
          let toolContent;
          if (cacheKey && repeated) {
            const cached = toolResultCache.get(cacheKey);
            // 缓存里存的是**正文**（首次构建后回填；若被压缩过则是压缩摘要）——
            // 命中时统一补上「请勿重复调用」提示，否则模型会把它当新结果继续空转。
            const body = cached && cached.content
              ? cached.content
              : buildToolContent(result, tc.name, malformed, false, dataTruncateCap);
            const reference = require('./toolResultReferences.cjs').project(body, tc.name, messages,
              (cfg.costSettings || require('./costSettings.cjs').parseSettings()).repeatResultReferences);
            toolContent = reference.content;
            if (reference.source) record.contextReference = reference.source;
            const stat = toolProjection.get(tc.name) || { calls: 0, rawTokens: 0, modelTokens: 0 };
            stat.calls++;
            stat.rawTokens += compactionLib.estimateTextTokens(REPEAT_NOTICE + body);
            stat.modelTokens += compactionLib.estimateTextTokens(toolContent);
            toolProjection.set(tc.name, stat);
            if (cached && cached.compressed) record.compressed = true;
          } else {
            toolContent = buildToolContent(result, tc.name, malformed, repeated, dataTruncateCap);
            /**
             * P2-2：记「原始结果 → 模型可见投影」的 token。
             * 「原始」= **投影之前**模型会看到的那份（即旧行为的 text + [data] 段），所以这里显式把
             * `modelContent` 摘掉再走一遍同一个 `buildToolContent` —— 口径与旧实现完全一致，
             * 不能用「text.length」近似，否则省下的到底是多少就对不上账。
             * 没有投影的工具有 raw == model，不去多算一遍（热路径成本为零）。
             */
            {
              const modelTokens = compactionLib.estimateTextTokens(toolContent);
              let rawTokens = modelTokens;
              if (result.modelContent != null) {
                try {
                  rawTokens = compactionLib.estimateTextTokens(
                    buildToolContent({ ...result, modelContent: null }, tc.name, malformed, repeated, dataTruncateCap),
                  );
                } catch {
                  rawTokens = modelTokens;
                }
              }
              const stat = toolProjection.get(tc.name) || { calls: 0, rawTokens: 0, modelTokens: 0 };
              stat.calls += 1;
              stat.rawTokens += rawTokens;
              stat.modelTokens += modelTokens;
              toolProjection.set(tc.name, stat);
            }
            // 回填缓存正文（此前只 set 了空串，命中路径因此丢 [data] 段）
            if (cacheKey && result.ok) {
              const entry = toolResultCache.get(cacheKey);
              if (entry && !entry.content) entry.content = toolContent;
            }
            // 子代理压缩（S10）：这里只**登记**待压缩项，等本轮所有工具执行完再合并成一次请求。
            // 当场逐个压缩时，N 份结果要付 N 遍 system 前缀 + N 次请求固定开销（而 system 是常量）。
            // max_calls 的额度按「已用调用数 + 本条占用的调用数」预判，避免一轮内无上限地登记。
            /**
     * P1-3：先看投影后的 token 是否够大，再以最多 2 个后续复用轮次做保守 ROI 预测。
             * 跳过的原因要计数（`compressionSkips`），否则「该压没压」和「不值得压」在账上没法区分。
             */
            const contentTokens = compactionLib.estimateTextTokens(toolContent);
            const compressDecision = compressionDecision({
              compression: cfg && cfg.compression,
              toolName: tc.name,
              contentTokens,
              contentChars: toolContent.length,
              usedCalls: compressCalls + pendingCompression.length,
              remainingRounds: Math.max(0, maxToolIterations - iter - 1),
              stats: compressionStats,
            });
            if (!compressDecision.compress && compressDecision.reason !== 'legacy-gate' && compressDecision.reason !== 'below-token-threshold') {
              compressionSkips.set(compressDecision.reason, (compressionSkips.get(compressDecision.reason) || 0) + 1);
              roundCompressionSkips.set(compressDecision.reason, (roundCompressionSkips.get(compressDecision.reason) || 0) + 1);
            }
            if (compressDecision.compress) {
              pendingCompression.push({
                contentTokens,
                toolName: tc.name,
                content: toolContent,
                record,
                cacheKey: cacheKey && result.ok ? cacheKey : null,
                messageIndex: messages.length,
                toolCallId: callId,
                expectedReuseRounds: compressDecision.expectedReuseRounds,
              });
            }
          }
          if (!toolContent) toolContent = result.text || '';
          roundObservations.push({ record, messageIndex: messages.length });
          const toolMessage = {
            role: 'tool',
            // 带上工具名（#22）：上下文硬裁剪的占位符要写清「原本是哪次调用的结果」。
            // 此前这里只有 role/tool_call_id/content，占位符只能渲染成「此处原本是 **工具** 的结果」，
            // 而「请用相同参数重新调用该工具」这句里最有用的恰恰就是工具名。
            // OpenAI 协议的 tool 消息本就允许 name 字段。
            name: tc.name,
            tool_call_id: callId,
            content: toolContent,
          };
          messages.push(toolMessage);
          resultArchive.track(toolMessage, record);
          /**
           * 图片类工具结果（view_image）：把图**作为一条 user 消息**附在工具结果之后。
           * OpenAI 兼容接口只在 user 消息里带 image_url 才可靠（tool 消息里带图会被部分供应商拒绝，
           * 口径见 electron/attachments.cjs 顶部注释）；上限与用户附件同一套（4MB/张），不另立一套。
           */
          const imageData = result && result.data && result.data.image;
          if (result.ok && imageData && imageData.dataUrl) {
            try {
              const attachmentLib = require('./attachments.cjs');
              const checked = attachmentLib.normalizeAttachments([{ dataUrl: imageData.dataUrl, name: imageData.path, bytes: imageData.bytes }]);
              if (checked.ok && Array.isArray(checked.attachments) && checked.attachments.length) {
                messages.push(
                  attachmentLib.buildUserMessage(
                    '（上面这次工具调用读取的图片，请直接依据画面内容继续：' + String(imageData.path || '') + '）',
                    checked.attachments
                  )
                );
                emitTrace({ kind: 'image_attached', turnId: iter, toolCallId: callId, name: tc.name, path: imageData.path || null, bytes: imageData.bytes || null });
                onDelta && onDelta({ kind: 'image_attached', tool: tc.name, path: imageData.path || null, bytes: imageData.bytes || null });
              } else {
                // 附不上去必须如实说，别让模型以为「我看过了」
                messages.push({
                  role: 'user',
                  content: '【系统提示】上一张图片未能附上（' + String(checked.error || '附件校验未通过') + '）：请改用其它方式获取信息，不要假设你看到了画面。',
                });
                emitTrace({ kind: 'image_attach_failed', turnId: iter, toolCallId: callId, reason: String(checked.error || '') });
              }
            } catch (error) {
              emitTrace({ kind: 'image_attach_failed', turnId: iter, toolCallId: callId, reason: String((error && error.message) || error) });
            }
          }
          onDelta && onDelta({ kind: 'tool_result', toolCalls: [record] });
          emitTrace({
            kind: 'tool',
            turnId: iter,
            toolCallId: callId,
            attemptId: callId + '#1',
            name: tc.name,
            repeated,
            malformed,
            compressed: !!record.compressed,
            ok: result.ok,
            elapsedMs: elapsed,
            args: tc.args || '',
          });
          try {
            const clean = JSON.stringify(args || {}).slice(0, 100);
            console.log(
              '[tool] iter=' + iter + ' ' + tc.name + (repeated ? ' (repeated, cached)' : '') +
                (malformed ? ' (MALFORMED ARGS)' : '') + ' ok=' + result.ok + ' ' + elapsed + 'ms' +
                (clean && clean !== '{}' ? ' args=' + safeLog(clean) : '')
            );
          } catch {}

          /**
           * 钩子（PostToolUse）：工具执行完（含失败）之后按配置跑用户声明的命令，输出作为
           * **机器注入的 user 消息**回灌给模型 —— 这样「改完代码自动跑 lint/测试」不再依赖模型自觉。
           * 三条纪律：
           *   ① 次数上限（hooks.max_runs）—— 否则「改文件 → lint 又改文件」会自己转起来；
           *   ② 注入消息同一时刻只留一条（原地替换，与进度提示同一套写法，避免越积越长）；
           *   ③ 未配置时**一次 spawn 都不发生**、一条消息都不注入（与没有这个模块时逐字节一致）。
           */
          if (hooksCfg.enabled && hooksCfg.rules.length) {
            // 次数上限：**先判**再跑；已达上限时也要让那条注入消息如实说明「不再执行」，
            // 否则模型会以为自己看到的还是最新一次 lint 结果（第一版就漏了这个「窗口期」）。
            if (hooksRunCount >= hooksCfg.maxRuns) hooksTruncated = hooksRunCount > 0;
            const matchedRules = hooksRunCount < hooksCfg.maxRuns ? hooksLib.matchRules(hooksCfg.rules, { tool: tc.name, ok: result.ok }) : [];
            for (const rule of matchedRules) {
              if (hooksRunCount >= hooksCfg.maxRuns) {
                hooksTruncated = true;
                break;
              }
              hooksRunCount += 1;
              const outcome = await hooksLib.runHook(rule, {
                projectRoot: traceProjectRoot(),
                policy: tools && tools.context && typeof tools.context.sandbox === 'function' ? tools.context.sandbox() : null,
                context: tools && tools.context,
                signal,
                defaults: hooksCfg,
              });
              hookResults.push({ tool: tc.name, rule, outcome });
              if (hookResults.length > 5) hookResults.shift();
              emitTrace({
                kind: 'hook',
                turnId: iter,
                toolCallId: callId,
                name: tc.name,
                rule: rule.id,
                ok: outcome.ok,
                skipped: !!outcome.skipped,
                exitCode: outcome.exitCode,
                timedOut: !!outcome.timedOut,
                elapsedMs: outcome.elapsedMs,
                reason: outcome.reason || null,
              });
              onDelta && onDelta({ kind: 'hook', tool: tc.name, rule: rule.id, ok: outcome.ok, skipped: !!outcome.skipped, truncated: !!outcome.truncated });
            }
            if (hookResults.length) {
              const note =
                hooksLib.renderHookNote(hookResults) +
                (hooksTruncated ? '\n（本 run 的钩子执行次数已达上限 ' + hooksCfg.maxRuns + '，后续不再执行）' : '');
              const hookAt = messages.findIndex(
                (msg) => msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(hooksLib.HOOK_NOTE_PREFIX)
              );
              if (hookAt >= 0) messages[hookAt] = { role: 'user', content: note };
              else messages.push({ role: 'user', content: note });
            }
          }
        }
        // 压缩结算（S10）：整轮登记的待压缩项交给 compressToolBatch —— 它内部按
        // agent.compression.batch_max_items 与 max_input_chars 分批，并按段把摘要写回 tool 消息。
        // 某一段拿不到摘要 → 该条退回单条压缩；整批失败 → 降级为截断（信息不丢，只是没压缩）。
        if (pendingCompression.length) {
          const compressionProjectRoot = tools.context && typeof tools.context.projectRoot === 'function' ? tools.context.projectRoot() : null;
          const compCfg = (cfg && cfg.compression) || {};
          const maxPerBatch = Math.max(1, compCfg.batchMaxItems || 4);
          const startedAt = Date.now();
          // P1-3：压缩前后各取一次账本游标 → 拿到这次压缩**实报**的 token 成本（见下面记账段）
          const ledgerCursor = cfg && cfg.costLedger && Array.isArray(cfg.costLedger.entries) ? cfg.costLedger.entries.length : 0;
          const outs = await compressToolBatch(
            cfg,
            pendingCompression.map((entry) => ({ toolName: entry.toolName, content: entry.content })),
            signal,
            { projectRoot: compressionProjectRoot },
          );
          // max_calls 仍按「压缩调用次数」计：一批算一次
          compressCalls += Math.max(1, Math.ceil(pendingCompression.length / maxPerBatch));
          pendingCompression.forEach((entry, i) => {
            const out = outs[i];
            if (!out) return;
            const msg = messages[entry.messageIndex];
            if (msg && msg.role === 'tool') msg.content = out.text;
            // 降级（压缩失败）时 msg.content 是**未压缩的原文**：不能再标成「已压缩」，
            // 否则 run 记录与界面都会以为这段已被摘要，而模型实际拿到的是完整原文。
            entry.record.compressed = out.degraded !== true;
            entry.record.compressionCache = out.cacheHit ? 'hit' : 'miss';
            entry.record.compressionMode = out.batched ? 'batch' : out.degraded ? 'degraded' : 'single';
            entry.record.compressedChars = { from: entry.content.length, to: out.text.length };
            if (entry.cacheKey) {
              const cachedEntry = toolResultCache.get(entry.cacheKey);
              if (cachedEntry) {
                cachedEntry.content = out.text;
                cachedEntry.compressed = out.degraded !== true;
              }
            }
          });
          /**
           * P1-3 预测和实绩分开：`estimatedNetTokensSaved` 按最多 2 个未来轮估算；
           * `netTokensSaved` 只在后续主请求成功携带这份摘要后增加。压缩调用成本按供应商实报 usage
           * 分摊；拿不到成本时标 `costKnown: false`，不把估算伪装成真实净收益。
           */
          const rawTokens = pendingCompression.reduce((sum, entry) => sum + (Number(entry.contentTokens) || 0), 0);
          const newTokens = pendingCompression.reduce(
            (sum, entry, i) => sum + compactionLib.estimateTextTokens((outs[i] && outs[i].text) || entry.content),
            0,
          );
          const ledger = cfg && cfg.costLedger && Array.isArray(cfg.costLedger.entries) ? cfg.costLedger.entries : null;
          const fresh = ledger ? ledger.slice(ledgerCursor) : [];
          const freshCompressionCalls = fresh.filter((entry) => entry && entry.kind === 'compression');
          const costTokens = fresh
            .filter((entry) => entry && entry.kind === 'compression')
            .reduce((sum, entry) => sum + (Number(entry.tokens && entry.tokens.prompt) || 0) + (Number(entry.tokens && entry.tokens.completion) || 0), 0);
          const costEntries = pendingCompression.filter((entry, index) => outs[index] && outs[index].cacheHit !== true);
          const costBasisTokens = costEntries.reduce((sum, entry) => sum + (Number(entry.contentTokens) || 0), 0);
          const costKnown = costEntries.length === 0 ||
            (freshCompressionCalls.length > 0 && freshCompressionCalls.every((entry) => entry.estimated !== true));
          const savedTokens = Math.max(0, rawTokens - newTokens);
          const remainingAfter = Math.max(0, maxToolIterations - iter - 1);
          const estimatedReuseRounds = Math.min(remainingAfter, MAX_COMPRESSION_FORECAST_ROUNDS);
          const estimatedNetTokensSaved = savedTokens * estimatedReuseRounds - costTokens;
          const netTokensImmediate = savedTokens - costTokens;
          pendingCompression.forEach((entry, i) => {
            const raw = Number(entry.contentTokens) || 0;
            const outTokens = compactionLib.estimateTextTokens((outs[i] && outs[i].text) || entry.content);
            const saved = Math.max(0, raw - outTokens);
            const stat = compressionStats.get(entry.toolName) || {
              calls: 0, rawTokens: 0, summaryTokens: 0, savedTokens: 0, costTokens: 0,
              realizedSavedTokens: 0, realizedCarryRequests: 0, costKnown: true,
              netTokensSaved: 0, netTokensImmediate: 0,
            };
            stat.calls += 1;
            stat.rawTokens += raw;
            stat.summaryTokens += outTokens;
            stat.savedTokens += saved;
            // 一批压缩 N 条：成本按原文 token 占比分摊；实际净节省只计成功后续请求确实携带的次数。
            const share = costBasisTokens > 0 && (!outs[i] || outs[i].cacheHit !== true)
              ? (costTokens * raw) / costBasisTokens
              : 0;
            stat.costTokens += share;
            stat.costKnown = stat.costKnown && costKnown;
            stat.netTokensSaved = stat.costKnown ? stat.realizedSavedTokens - stat.costTokens : null;
            stat.netTokensImmediate = stat.costKnown ? stat.savedTokens - stat.costTokens : null;
            compressionStats.set(entry.toolName, stat);
            entry.record.netTokensSaved = stat.netTokensSaved == null ? null : Math.round(stat.netTokensSaved);
            entry.record.estimatedNetTokensSaved = Math.round(saved * Math.min(entry.expectedReuseRounds || 0, remainingAfter) - share);
            entry.record.realizedCarryRequests = 0;
            entry.record.compressedTokens = { from: raw, to: outTokens };
            if (outs[i] && outs[i].degraded !== true) {
              compressedCarryEntries.push({
                toolName: entry.toolName,
                toolCallId: entry.toolCallId,
                summary: String(outs[i].text || ''),
                savedTokens: saved,
                costKnown,
                carries: 0,
                active: true,
                record: entry.record,
              });
            }
          });
          const netTokensSaved = [...compressionStats.values()].reduce(
            (sum, stat) => sum + (Number(stat.netTokensSaved) || 0),
            0,
          );
          emitTrace(
            {
              kind: 'compression',
              turnId: iter,
              items: pendingCompression.length,
              batchSize: Math.min(maxPerBatch, pendingCompression.length),
              tools: pendingCompression.map((entry) => entry.toolName),
              cacheHits: outs.filter((out) => out && out.cacheHit).length,
              elapsedMs: Date.now() - startedAt,
              // P1-3：净收益账（口径见上面注释）+ 本 run 跳过的压缩原因计数
              rawTokens,
              newTokens,
              savedTokens,
              costTokens,
              costKnown,
              maxRemainingRounds: remainingAfter,
              estimatedReuseRounds,
              estimatedNetTokensSaved,
              realizedCarryRequests: [...compressionStats.values()].reduce(
                (sum, stat) => sum + (Number(stat.realizedCarryRequests) || 0),
                0,
              ),
              realizedSavedTokens: [...compressionStats.values()].reduce(
                (sum, stat) => sum + (Number(stat.realizedSavedTokens) || 0),
                0,
              ),
              netTokensSaved,
              netTokensImmediate,
              skips: Object.fromEntries(compressionSkips),
            },
            compressionProjectRoot,
          );
        }
        /**
         * P1-3：本轮一条都没压、但**有意跳过**过（最后一轮 / ROI 不划算 / 同类工具净亏）→ 也留一条 trace。
         * 不留痕的话，「该压没压」和「不值得压」在账上就分不出来了。
         */
        if (!pendingCompression.length && roundCompressionSkips.size) {
          emitTrace({ kind: 'compression_skipped', turnId: iter, skips: Object.fromEntries(roundCompressionSkips) });
        }
        // 只在本 run 内合并工具结果；追加到最后一条 tool 消息以保持协议配对和信任级别。
        if (cfg && cfg.observation && cfg.observation.enabled && roundObservations.length) {
          const patches = roundObservations.map(({ record, messageIndex }) =>
            observationState.adaptToolResult(record, messages[messageIndex] && messages[messageIndex].content),
          );
          observationState.reduceToolResults(observationBoard, patches);
          const view = observationState.synthesizeObservation(observationBoard, cfg.observation);
          const lastToolMessage = messages[roundObservations[roundObservations.length - 1].messageIndex];
          if (lastToolMessage && lastToolMessage.role === 'tool') lastToolMessage.content += '\n\n' + view;
          emitTrace({ kind: 'observation', turnId: iter, toolCalls: patches.length, revision: observationBoard.revision, chars: view.length });
        }
        // 失败按**类别**分派提示（S5）：参数错 → 改参数重试；权限/用户拒绝 → 别原样重试、要人介入；
        // 超时 → 缩小范围；副作用未知 → 先只读核对；认不出来的码按最保守处理。
        // 同一个 toolCallId 最多提示 NUDGE_MAX_PER_CALL 次，超过的只落 trace（由迭代上限兜底），
        // 避免「一句话反复灌」既占上下文又诱导模型重复同一次失败调用。
        if (failedAny && !capped) {
          const roundFailures = allToolCalls
            .slice(-toolCalls.length)
            .filter((record) => record.ok === false)
            .map((record) =>
              record.failure ||
              failures.classifyFailure(
                { ok: false, text: record.result, data: record.data },
                { tool: record.name, toolCallId: record.callId },
              ),
            );
          const plan = failures.planNudges(roundFailures, nudgeCounts, failures.NUDGE_MAX_PER_CALL);
          const nudgeText = failures.buildFailureNudge(plan.emitted);
          if (nudgeText) messages.push({ role: 'user', content: nudgeText });
          if (plan.emitted.length || plan.skipped.length) {
            emitTrace({
              kind: 'failure_taxonomy',
              turnId: iter,
              nudged: plan.emitted.map((item) => ({ tool: item.tool, code: item.code, category: item.category, retryable: item.retryable })),
              suppressed: plan.skipped.map((item) => ({ tool: item.tool, code: item.code, nudges: item.nudges })),
            });
          }
        }
        emitTrace({
          kind: 'round_end',
          turnId: iter,
          finishReason: finishReason || null,
          toolCount: toolCalls.length,
          executed: totalToolCalls,
          capped,
        });
        codeVerifier?.endRound();
        if (codeVerifier?.dirty.size) {
          publishCodeVerification({ status: 'running', verified: false, files: [...codeVerifier.dirty], checks: [] }, false);
          publishCodeVerification(await codeVerifier.flush(signal));
        }
        // 断点续跑：每轮结束保存对话快照，崩溃后能凭它重建上下文而不是重新问用户
        if (tools.context && typeof tools.context.checkpointMessages === 'function') {
          tools.context.checkpointMessages(messages, 'round_end', {
            model: cfg.model,
            modelTaskType: cfg.modelTaskType || 'main',
            reasoningEffort: cfg.reasoningEffort || null,
            compacted: compactionCount,
            contextTrims: contextTrimCount,
            contextTrimmedChars,
            overflowRecoveries,
          });
        }
        if (capped) {
          stopReason = 'tool_limit';
          break;
        }
        transitionState(STATES.RUNNING, 'tools_settled');
        // Tool-round narration stays in the conversation/audit, but is not the final answer.
        // Clear its streamed bubble before delivering (and checking) the next response.
        if (content) {
          toolRoundNarration += content;
          content = '';
          onDelta && onDelta({ kind: 'content_reset', reason: 'tool_round_settled' });
        }
        continue;
      }
      if (cfg.taskAcceptanceRunner) {
        const runner = cfg.taskAcceptanceRunner, before = runner.calls;
        await runner.check(signal, totalToolCalls - before); totalToolCalls += runner.calls - before;
        if (runner.blocked()) {
          if (signal?.aborted) throw Error('任务验收已取消');
          if (totalToolCalls >= maxTotalToolCalls || cfg.requestBudget?.remaining() <= 0) throw Object.assign(Error('验收未通过且运行额度已耗尽。'), { code: cfg.requestBudget?.remaining() <= 0 ? 'BUDGET_EXCEEDED' : 'TASK_ACCEPTANCE_FAILED' });
          if (verificationRetries++ >= 1) throw Object.assign(Error('显式任务验收未通过，修改已保留。'), { code: 'TASK_ACCEPTANCE_FAILED' });
          messages.push({ role: 'assistant', content: content || res.content || '' }, { role: 'user', content: runner.note() });
          content = ''; onDelta?.({ kind: 'content_reset', reason: 'task_acceptance_failed' }); continue;
        }
      }
      if (codeVerifier) {
        codeVerifier.freshness();
        if (codeVerifier.dirty.size) publishCodeVerification(await codeVerifier.flush(signal));
        else publishCodeVerification(codeVerifier.report, false);
        if (codeVerifier.blocked()) {
          if (verificationRetries < 1) {
            verificationRetries++;
            messages.push({ role: 'assistant', content: content || res.content || '' });
            messages.push({ role: 'user', content: '【系统提示】代码校验尚未通过。根据校验报告修复，再交付；不能用旧结果声明当前版本已通过。' });
            content = ''; onDelta && onDelta({ kind: 'content_reset', reason: 'code_verification_failed' }); continue;
          }
          const error = '修改后校验未通过，当前文件已保留，请根据运行记录修复。';
          const outcome = finalizeState({ error, stopReason: 'code_verification_failed' }, 'code_verification_failed');
          onDelta && onDelta({ kind: 'content_reset', reason: 'code_verification_failed' });
          onDelta && onDelta({ kind: 'content', text: error });
          onDelta && onDelta({ kind: 'error', error, stopReason: 'code_verification_failed', state: outcome.state });
          return { content: error, reasoning, toolCalls: allToolCalls, usage, error, stopReason: 'code_verification_failed', state: outcome.state, outcome, iterations: modelTurns };
        }
      }
      // P6：enforce 模式下，引用不可信的答案不允许直接交付 —— 先给一次订正机会
      // （enforce 之外一律不进入这个分支，warn 行为与之前逐字一致）。
      if (strictDelivery && groundingRetries < maxGroundingRetries) {
        const pending = await checkGrounding(content);
        if (deliveryRejected(pending)) {
          groundingRetries += 1;
          messages.push({ role: 'assistant', content: content });
          const taskReminder = groundingTask ? '【任务回顾】本轮用户请求：' + JSON.stringify(groundingTask.slice(0, 4000)) +
            (groundingTask.length > 4000 ? '（此处节选，完整请求仍以用户消息为准）' : '') +
            '\n请按这项请求重写最终答案，不要逐项回答校验报告中的旁支问题。\n' : '';
          messages.push({ role: 'user', content: taskReminder + groundingRetryPrompt(pending) });
          emitTrace({ kind: 'grounding_retry', turnId: iter, status: pending.status, invalid: pending.invalid || [] });
          if (onDelta) onDelta({ kind: 'grounding', grounding: pending, warning: groundingWarning(pending) });
          content = '';
          onDelta && onDelta({ kind: 'content_reset', reason: 'grounding_retry' });
          continue;
        }
      }
      content = content || res.content || '';
      endedNaturally = true;
      // 回答本身被截断（且补问次数已用尽）：如实标记，别让调用方以为这是完整的最终答案
      if (finishReason === 'length') {
        stopReason = 'length_truncated';
        onDelta &&
          onDelta({
            kind: 'truncated',
            count: truncationNudges,
            max: maxTruncationNudges,
            finishReason,
            continuing: false,
          });
      }
      if (!content && reasoning) {
        onDelta && onDelta({ kind: 'content', text: '' });
      }
      break;
    }
    if (!endedNaturally) {
      // 上限收尾（第 2 项）：不再只给一句「任务未完成」——把这一轮真实执行过什么、失败什么、
      // 涉及哪些文件、怎么续跑，作为**阶段性结果**交付（模型已输出的部分保留在前面）。
      const wrapUp = buildLimitWrapUp({ stopReason, toolCalls: allToolCalls, loopIterations, modelTurns });
      const error = stopReason === 'tool_limit' ? '已达到工具调用上限，任务未完成。' : '已达到模型迭代上限，任务未完成。';
      const partial = strictDelivery ? '' : toolRoundNarration + content;
      const wrapped = partial ? partial + '\n\n' + wrapUp.text : wrapUp.text;
      // 上限不是「执行失败」：状态单列为 LIMIT_REACHED（调用方可据此提示续跑而不是让用户去排查错误）
      const outcome = finalizeState({ error, stopReason }, stopReason);
      emitTrace({ kind: 'limit_wrapup', turnId: loopIterations, stopReason, executed: wrapUp.data.executed, failed: wrapUp.data.failed, touchedFiles: wrapUp.data.touchedFiles, contextTrims: contextTrimCount });
      // 兼容既有契约：`error` delta 依然发（消费方/评测 `delta-kind: error` 锁着它，别偷偷换成别的 kind，
      // 那会让上游判据变成红墙）；结构化收尾另走 limit_reached，两者是补充关系。
      onDelta && onDelta({ kind: 'error', error, stopReason, state: outcome.state });
      onDelta && onDelta({ kind: 'limit_reached', error, stopReason, state: outcome.state, limitKind: outcome.limitKind, wrapUp: wrapUp.data, text: wrapUp.text });
      return { content: wrapped, reasoning, toolCalls: allToolCalls, usage, error, stopReason, state: outcome.state, outcome, iterations: modelTurns, wrapUp: wrapUp.data, contextTrims: contextTrimCount, contextTrimmedChars, compacted: compactionCount };
    }
    let grounding = await checkGrounding(content);
    let rejectedDraft = null;
    if (strictDelivery && deliveryRejected(grounding) && !signal?.aborted) {
      try {
        const repair = await require('./rag/deliveryRepair.cjs').repairDelivery({ answer: content, question: groundingTask,
          calls: allToolCalls, grounding, check: checkGrounding, rejected: deliveryRejected, judge: judgeDelivery });
        emitTrace({ kind: 'delivery_repair', ...repair.audit });
        if (repair.audit.accepted) {
          rejectedDraft = content; content = repair.answer; grounding = repair.grounding;
          grounding.deliveryRepair = repair.audit;
        }
      } catch (error) {
        emitTrace({ kind: 'delivery_repair', accepted: false, error: String(error?.message || error) });
      }
    }
    if (semanticEnforce && grounding.semantic?.status === 'judged' && deliveryRejected(grounding)) {
      // This text makes no project assertion. It is delivered only if both judges
      // confirm a relevant evidence limitation; sufficient evidence prevents fallback.
      const limited = '针对本轮问题，已检查的源码证据不足以给出可靠结论；目前无法据此说明所问机制或事实。';
      const limitedGrounding = await checkGrounding(limited);
      const accepted = limitedGrounding.semantic?.status === 'abstained' && limitedGrounding.semantic.safeForDelivery === true && !deliveryRejected(limitedGrounding);
      emitTrace({ kind: 'abstention_fallback', accepted, status: limitedGrounding.semantic?.status });
      if (accepted) { rejectedDraft = content; content = limited; grounding = limitedGrounding; }
    }
    const warning = groundingWarning(grounding);
    // enforce 模式下仍未通过 = 交付门槛不达标：如实上报（既不静默放过，也不把提示写进正文）
    const groundingBlocked = deliveryRejected(grounding);
    // 校验结果只作为独立事件上报（界面另有来源徽标），不拼进交付内容：
    // 引用校验本身可能误判，把提示写进回答正文会污染交付文本。
    if (warning) onDelta && onDelta({ kind: 'grounding', grounding, warning });
    if (groundingBlocked) onDelta && onDelta({ kind: 'grounding_blocked', grounding, warning, retries: groundingRetries });
    if (strictDelivery) {
      onDelta && onDelta({ kind: 'content_reset', reason: groundingBlocked ? 'delivery_rejected' : 'grounding_verified' });
      onDelta && onDelta({ kind: 'content', text: groundingBlocked ? GROUNDING_REJECTION_TEXT : content });
    }
    const finalVerification = codeVerifier?.freshness();
    if (finalVerification) publishCodeVerification(finalVerification, false);
    if (finalVerification?.status === 'stale' && codeVerifier?.blocked()) {
      const error = '交付前被测内容已变化，旧校验失效，当前修改已保留。';
      const outcome = finalizeState({ error, stopReason: 'code_verification_failed' }, 'code_verification_failed');
      onDelta && onDelta({ kind: 'content_reset', reason: 'code_verification_stale' });
      onDelta && onDelta({ kind: 'content', text: error });
      onDelta && onDelta({ kind: 'error', error, state: outcome.state });
      return { content: error, reasoning, toolCalls: allToolCalls, usage, error, state: outcome.state, outcome, iterations: modelTurns };
    }
    if (cfg.taskAcceptanceRunner?.freshness() && cfg.taskAcceptanceRunner.blocked()) throw Object.assign(Error('交付前任务验收证据失效。'), { code: 'TASK_ACCEPTANCE_FAILED' });
    onDelta && onDelta({ kind: 'done', grounding });
    emitTrace({
      kind: 'turn_end', totalToolCalls, executedUnique: allToolCalls.filter((t) => !t.repeated).length,
      repeated: allToolCalls.filter((t) => t.repeated).length, iterations: loopIterations, modelTurns,
      resultLen: content.length, finishReason: lastFinishReason, grounding, streamRestarts,
    });
    const finalStopReason = stopReason === 'length_truncated' ? stopReason : null;
    const outcome = finalizeState({ stopReason: finalStopReason }, finalStopReason || 'answer_complete');
    return {
      content,
      ...(rejectedDraft ? { rejectedContent: rejectedDraft } : {}),
      reasoning,
      toolCalls: allToolCalls,
      usage,
      grounding,
      codeVerification: finalVerification || null,
      finishReason: lastFinishReason,
      state: outcome.state,
      outcome,
      stateHistory: machine.history.slice(),
      iterations: modelTurns,
      streamRestarts,
      ...(endedNaturally && stopReason === 'length_truncated' ? { stopReason: 'length_truncated' } : {}),
      ...(groundingBlocked ? { groundingBlocked: true, groundingRetries } : {}),
      contextTrims: contextTrimCount,
      contextTrimmedChars,
      // 用户插话（steering）：本轮一共插进去几条（0 = 用户全程没插话）
      steeringInjected: steerCount,
      // 上下文压缩（照 Codex）：次数 + 最后一次的交接摘要（界面据此把旧消息折叠成摘要卡）
      compacted: compactionCount,
      // 供应商报超窗后「降级窗口 + 压一次 + 重发」救回来的次数（0 = 没发生过）
      overflowRecoveries,
      contextSummary: lastContextSummary || undefined,
      contextSummaryEnvelope: lastContextSummary ? compactionLib.buildSummaryEnvelope(lastContextSummary) : undefined,
    };
  } catch (e) {
    if (signal && signal.aborted) {
      const outcome = machine.isTerminal()
        ? describeOutcome({ state: machine.state, stopReason: 'aborted' })
        : finalizeState({ aborted: true }, 'aborted');
      onDelta && onDelta({ kind: 'stopped' });
      return { content, reasoning, toolCalls: allToolCalls, usage, aborted: true, state: outcome.state, outcome, iterations: modelTurns, contextTrims: contextTrimCount, contextTrimmedChars, compacted: compactionCount, overflowRecoveries };
    }
    const error = String((e && e.message) || e);
    if (e.code === 'TASK_ACCEPTANCE_FAILED') { content = error; onDelta?.({ kind: 'content_reset', reason: 'task_acceptance_failed' }); onDelta?.({ kind: 'content', text: error }); }
    const budgetStopReason = ({
      COST_BUDGET_EXCEEDED: 'cost_limit',
      RETRY_BUDGET_EXCEEDED: 'retry_limit',
      BUDGET_EXCEEDED: 'token_limit',
    })[e && e.code] || null;
    if (budgetStopReason && cfg.limits?.budgetWrapUp === true) {
      const handoff = await require('./budgetWrapUp.cjs').finishBudgetWork({ cfg, messages, toolCalls: allToolCalls, forced: true,
        stopReason: budgetStopReason, verification: codeVerifier?.freshness(), signal, makeWrapUp: buildLimitWrapUp, emitTrace, onDelta,
        finalizeState, modelTurns, checkpoint: tools?.context?.checkpointMessages?.bind(tools.context) }).catch(error => {
          if (!signal?.aborted) throw error;
          const outcome = finalizeState({ aborted: true }, 'aborted'); onDelta?.({ kind: 'stopped' });
          return { content: '', toolCalls: allToolCalls, aborted: true, state: outcome.state, outcome, iterations: modelTurns };
        });
      if (handoff) return { ...handoff, reasoning, usage, contextTrims: contextTrimCount, contextTrimmedChars, compacted: compactionCount };
    }
    const outcome = machine.isTerminal()
      ? describeOutcome({ state: machine.state })
      : finalizeState({ error, stopReason: budgetStopReason }, budgetStopReason || 'exception:' + error.slice(0, 120));
    onDelta && onDelta({ kind: 'error', error, state: outcome.state, ...(budgetStopReason ? { stopReason: budgetStopReason } : {}) });
    if (budgetStopReason) {
      emitTrace({ kind: 'budget_limit', code: e.code, stopReason: budgetStopReason, limitKind: outcome.limitKind });
      onDelta && onDelta({ kind: 'limit_reached', error, stopReason: budgetStopReason, state: outcome.state, limitKind: outcome.limitKind });
    }
    return { content, reasoning, toolCalls: allToolCalls, usage, error, state: outcome.state, outcome,
      ...(budgetStopReason ? { stopReason: budgetStopReason } : e.code === 'TASK_ACCEPTANCE_FAILED' ? { stopReason: 'task_acceptance_failed' } : {}),
      iterations: modelTurns, contextTrims: contextTrimCount, contextTrimmedChars, compacted: compactionCount, overflowRecoveries };
  }
}

const GROUNDING_REJECTION_TEXT = '本次答复未通过来源或事实校验，未作为最终结论交付。可以补读相关源码后继续核验。';
/** @returns {Promise<Awaited<ReturnType<typeof runAgentChatInternal>> & {rejectedContent?: string}>} */
async function runAgentChat(options) {
  const strictDelivery = options.cfg?.grounding?.mode === 'enforce' || options.cfg?.grounding?.semanticMode === 'enforce';
  // The tool loop appends machine-generated user messages; those are not personality evidence.
  const soulMessages = (options.soulMessages || options.messages).filter(m => m.role === 'user')
    .map(m => ({ role: m.role, content: m.content }));
  const taskAcceptance = await require('./taskAcceptance.cjs').prepare(options);
  const result = await runAgentChatInternal({ ...options, cfg: { ...options.cfg, taskAcceptanceRunner: taskAcceptance } });
  result.taskAcceptance = taskAcceptance.report; taskAcceptance.publish();
  if (options.soulEvolution && !taskAcceptance.blocked() && !result.groundingBlocked && result.wrapUp?.phase !== 'budget_wrapup') {
    try {
      const growth = await require('./soulEvolution.cjs').evolveSoul({ cfg: options.cfg,
        messages: soulMessages, result, signal: options.signal,
        chat: async (cfg, messages, requestOptions) => {
          const startedAt = Date.now();
          const response = await chatCompletion(cfg, messages, requestOptions);
          if (response.usage) recordCost(options.cfg, { kind: 'soul-reflection',
            model: response.actualModel || cfg.model, usage: response.usage,
            attempt: response.httpAttempts, latencyMs: Date.now() - startedAt,
            runId: options.cfg.costRunId, meta: { perAttempt: true } });
          return response;
        } });
      options.onDelta && options.onDelta({ kind: 'soul_growth', soul: growth });
    } catch (error) {
      console.warn('[soul] 人格成长暂未保存：' + error.message);
      options.onDelta && options.onDelta({ kind: 'soul_growth', soul: { status: 'error', error: error.message } });
    }
  }
  if (result.groundingBlocked) return { ...result, rejectedContent: result.content, content: GROUNDING_REJECTION_TEXT };
  if (!strictDelivery) return result;
  if ((result.error || result.aborted) && !result.wrapUp) return { ...result, rejectedContent: result.content,
    content: result.aborted ? '任务已停止，尚未验证的答复未交付。' : '任务未完成，尚未验证的答复未交付。' };
  return result;
}

module.exports = {
  loadConfig,
  DEFAULTS,
  parseSandboxConfig,
  recordCost,
  parseCostPrices,
  parseAlertThresholds,
  loadSoul,
  parseSoul,
  buildSystemPrompt,
  resolvePromptLayers,
  // P1-2：预算裁剪的两个纯函数（导出以便判据直锁）
  truncateCanvasSummary,
  truncateSkillsIndex,
  CANVAS_RULES,
  CANVAS_RULES_STUB,
  PROMPT_SECTIONS,
  RUNTIME_RULE_GATES,
  RUNTIME_RULE_DISCOVER,
  TASK_RULE_NUMBERS,
  TASK_RULES_TITLE,
  orderPromptSections,
  splitPromptSections,
  splitRuntimeRules,
  buildModelIdentityBlock,
  buildToolGuide,
  chatCompletion,
  validateRagGrounding,
  chatCompletionStream,
  logConversation,
  resolveSoulPath,
  parseToolsConfig,
  runAgentChat,
  logToolTrace,
  parseRagConfig,
  parseGroundingConfig,
  parseLimitsConfig,
  parseContextConfig,
  parseCompactionConfig,
  classifyContextOverflow,
  noteContextOverflow,
  parseOverflowNumbers,
  isContextWindowOverrideAuthoritative,
  getContextWindowOverride,
  resetContextWindowOverrides,
  buildLimitWrapUp,
  mergeUsage,
  assignCallIds,
  redactSecrets,
  chatBody,
  buildProgressNote,
  PROGRESS_NOTE_PREFIX,
  buildPlanNote,
  PLAN_NOTE_PREFIX,
  readRunPlan,
  buildSkillsIndex,
  parseReasoningEffort,
  parseReliabilityConfig,
  parseMemoryConfig,
  shouldCompress,
  compressionDecision,
  compressionRoi,
  buildToolContent,
  COMPRESSOR_SYSTEM_PROMPT,
  compressToolContent,
  compressToolBatch,
  buildCompressionBatchMessages,
  parseCompressionBatchOutput,
  chunkCompressionItems,
  parseCompressionConfig,
  parseSubagentConfig,
  SCALAR_BACKED_TOOLS,
  CACHEABLE_TOOLS,
  MUTATION_TOOLS,
};
