'use strict';

const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_TURN_TIMEOUT_MS = 600000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_STREAM_MAX_ATTEMPTS = 2;
const DEFAULT_TRUNCATION_NUDGES = 4;

const DEFAULTS = Object.freeze({
  maxTokens: DEFAULT_MAX_TOKENS,
  turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  streamMaxAttempts: DEFAULT_STREAM_MAX_ATTEMPTS,
  truncationNudges: DEFAULT_TRUNCATION_NUDGES,
});

function configInteger(cfg, key, fallback, min, max) {
  const raw = cfg[key];
  const n = Number(typeof raw === 'string' ? raw.replace(/\s+#.*$/, '').trim() : raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function configNumber(cfg, key, fallback, min, max) {
  const raw = cfg[key];
  const n = Number(typeof raw === 'string' ? raw.replace(/\s+#.*$/, '').trim() : raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function configList(cfg, key) {
  return String(cfg[key] || '').split(',').map(item => item.trim()).filter(Boolean);
}
function configFlag(cfg, key, fallback) {
  if (cfg[key] == null) return fallback;
  return String(cfg[key]).replace(/\s+#.*$/, '').trim().toLowerCase() !== 'false';
}

const REASONING_EFFORT_DEFAULT = 'medium';
const REASONING_EFFORT_OFF = new Set(['none', 'off', 'false', 'no', '-', 'null', 'disabled']);
function parseReasoningEffort(raw) {
  if (raw == null) return REASONING_EFFORT_DEFAULT;
  const value = String(raw).trim();
  if (!value || REASONING_EFFORT_OFF.has(value.toLowerCase())) return null;
  return value;
}

function parseReliabilityConfig(cfg) {
  return {
    maxAttempts: configInteger(cfg, 'agent.request_max_attempts', 3, 1, 5),
    retryBaseMs: configInteger(cfg, 'agent.retry_base_ms', 400, 50, 5000),
    retryMaxMs: configInteger(cfg, 'agent.retry_max_ms', 5000, 250, 30000),
    turnTimeoutMs: configInteger(cfg, 'agent.turn_timeout_ms', DEFAULT_TURN_TIMEOUT_MS, 10000, 3600000),
    streamIdleTimeoutMs: configInteger(cfg, 'agent.stream_idle_timeout_ms', DEFAULT_STREAM_IDLE_TIMEOUT_MS, 10000, 600000),
    streamMaxAttempts: configInteger(cfg, 'agent.stream_max_attempts', DEFAULT_STREAM_MAX_ATTEMPTS, 0, 4),
    truncationNudges: configInteger(cfg, 'agent.truncation_nudges', DEFAULT_TRUNCATION_NUDGES, 0, 8),
  };
}

function parseSandboxConfig(cfg) {
  return {
    mode: String(cfg['sandbox.mode'] || 'best-effort').trim().toLowerCase(),
    network: String(cfg['sandbox.network'] || 'deny').trim().toLowerCase(),
    requireFilesystem: /^(1|true|yes|on)$/i.test(String(cfg['sandbox.require_filesystem'] || '')),
    maxProcesses: configInteger(cfg, 'sandbox.max_processes', 0, 0, 4096),
    maxMemoryMB: configInteger(cfg, 'sandbox.max_memory_mb', 0, 0, 1024 * 1024),
    cpuSeconds: configInteger(cfg, 'sandbox.cpu_seconds', 0, 0, 86400),
    allowWrite: configList(cfg, 'sandbox.allow_write'),
  };
}

function parseLimitsConfig(cfg) {
  return {
    budgetWrapUp: configFlag(cfg, 'agent.budget.wrap_up', false),
    noProgressDetection: configFlag(cfg, 'agent.no_progress.enabled', false),
    noProgressRounds: configInteger(cfg, 'agent.no_progress.rounds', 3, 2, 20),
    workspaceCacheVersions: configFlag(cfg, 'agent.cache.workspace_versions', true),
    workingState: configFlag(cfg, 'agent.working_state.enabled', false),
    progressEvery: configInteger(cfg, 'agent.progress_every', 3, 0, 50),
    outputTiers: cfg['agent.output_budget_tiers'] == null ? true : String(cfg['agent.output_budget_tiers']).toLowerCase() !== 'false',
    toolMaxTokens: configInteger(cfg, 'agent.output_budget_tool', 12000, 1000, 200000),
    finalMaxTokens: configInteger(cfg, 'agent.output_budget_final', 32000, 1000, 200000),
    truncationBumps: configInteger(cfg, 'agent.truncation_budget_bumps', 1, 0, 5),
    maxConcurrentRuns: configInteger(cfg, 'agent.max_concurrent_runs', 2, 1, 8),
    maxTotalTokens: configInteger(cfg, 'agent.max_total_tokens', 600000, 10000, 4000000),
    maxTotalRetries: configInteger(cfg, 'agent.max_total_retries', 12, 0, 100),
    maxCostUsd: require('./costBudget.cjs').parseCostLimit(cfg['agent.max_cost_usd']),
    maxToolIterations: configInteger(cfg, 'agent.max_tool_iterations', 12, 1, 200),
    maxTotalToolCalls: configInteger(cfg, 'agent.max_total_tool_calls', 100, 1, 2000),
    dataTruncateCap: configInteger(cfg, 'agent.data_truncate_cap', 120000, 2000, 2000000),
  };
}

module.exports = {
  DEFAULTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_ATTEMPTS,
  DEFAULT_TRUNCATION_NUDGES,
  configInteger,
  configNumber,
  configList,
  configFlag,
  parseReasoningEffort,
  parseReliabilityConfig,
  parseSandboxConfig,
  parseLimitsConfig,
};
