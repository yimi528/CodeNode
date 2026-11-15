'use strict';
function parseOverflowNumbers(message) {
  const text = String(message || '');
  let window = 0;
  let inputTokens = 0;
  const winPatterns = [
    /maximum\s+context\s+length\s+(?:is|of)\s+(\d{3,9})/i,
    /maximum\s+context\s+window\s+(?:is|of)\s+(\d{3,9})/i,
    /context\s+(?:window|length)\s+(?:is|of|:)\s*(\d{3,9})/i,
    /(?:上下文|模型)(?:长度|窗口)?(?:上限|最大)[^0-9]{0,12}(\d{3,9})/,
  ];
  for (const pattern of winPatterns) {
    const m = text.match(pattern);
    const value = m ? Number(m[1]) || 0 : 0;
    if (value > 0) {
      window = value;
      break;
    }
  }
  const inMatch =
    text.match(/\(\s*(\d{3,9})\s*(?:tokens?\s*)?in\s+the\s+messages/i) ||
    text.match(/(\d{3,9})\s*(?:tokens?\s*)?in\s+the\s+messages/i);
  if (inMatch) inputTokens = Number(inMatch[1]) || 0;
  return { window, inputTokens };
}

/**
 * 进程内的窗口账本：`key -> { window, source }`。
 * `source === 'provider'` 表示这个值来自供应商报错里**明确报出的窗口**（可信，可用于预检拒发）；
 * `source === 'estimated'` 表示只是我们按估算推出来的下界（**只**影响压缩触发线，绝不参与拒发）。
 */
const contextWindowOverrides = new Map();

function contextWindowKey(cfg) {
  return String((cfg && cfg.apiBase) || '') + '|' + String((cfg && cfg.model) || '');
}

/**
 * 记下一次「供应商说超窗」。
 *
 * 优先采用报错里明确报出的真实窗口；拿不到才退回 `估算 × 0.9` 这个下界。
 * 同口径取**历史最小值**（多次被拒说明猜得还不够保守）；但估算值**不得覆盖**可信值。
 * @param {any} cfg
 * @param {number|{tokens?: number, providerMessage?: string, message?: string}} tokensOrInfo
 * @returns {number} 记录后的窗口
 */
function noteContextOverflow(cfg, tokensOrInfo) {
  /** @type {{tokens?: number, providerMessage?: string, message?: string}} */
  const info = tokensOrInfo && typeof tokensOrInfo === 'object' ? tokensOrInfo : { tokens: Number(tokensOrInfo) };
  const key = contextWindowKey(cfg);
  const parsed = parseOverflowNumbers(info.providerMessage || info.message || '');
  const candidate =
    parsed.window > 0
      ? { window: Math.max(1024, parsed.window), source: 'provider' }
      : { window: Math.max(1024, Math.floor((Number(info.tokens) || 0) * 0.9)), source: 'estimated' };
  const prev = contextWindowOverrides.get(key);
  if (!prev) {
    contextWindowOverrides.set(key, candidate);
    return candidate.window;
  }
  // 可信口径优先于估算口径；估算值永远不能把可信值改小
  if (candidate.source === 'provider' && prev.source !== 'provider') {
    contextWindowOverrides.set(key, candidate);
    return candidate.window;
  }
  if (candidate.source === 'estimated' && prev.source === 'provider') return prev.window;
  if (candidate.window < prev.window) {
    contextWindowOverrides.set(key, candidate);
    return candidate.window;
  }
  return prev.window;
}

function getContextWindowOverride(cfg) {
  const entry = contextWindowOverrides.get(contextWindowKey(cfg));
  return entry ? entry.window : 0;
}

/** 该窗口是否来自供应商明确报出的值（只有它才允许参与预检拒发）。 */
function isContextWindowOverrideAuthoritative(cfg) {
  const entry = contextWindowOverrides.get(contextWindowKey(cfg));
  return !!entry && entry.source === 'provider';
}

/** 用例/自检用：清空窗口降级账本 */
function resetContextWindowOverrides() {
  contextWindowOverrides.clear();
}

/**
 * 判断一个请求错误是不是「上下文超窗」。只认「HTTP 4xx + 上下文/长度相关措辞」——
 * 光看 400 会把「工具 schema 非法」这类真错误误判成超窗，那会掩盖真因。
 * @returns {{message: string, status: number|null}|null}
 */
function classifyContextOverflow(error) {
  const parts = [];
  const push = (value, depth) => {
    if (!value || depth > 2) return;
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'object') {
      if (value.message) parts.push(String(value.message));
      if (value.cause && depth < 2) push(value.cause, depth + 1);
      if (value.error && depth < 2) push(value.error, depth + 1);
    }
  };
  push(error, 0);
  const text = parts.join(' | ').slice(0, 2000);
  if (!text) return null;
  const statusMatch = text.match(/HTTP\s+(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const overflowish = /context[_ ]length|maximum context|max(?:imum)?[ _]?context[_ ]?(?:length|tokens)|reduce the length|too many tokens|exceed(?:s|ed)?[^.]{0,24}context|上下文.{0,6}(?:超|过长|上限)|tokens? in the (?:messages|completion)/i.test(
    text
  );
  const httpish = status === null || status === 400 || status === 413 || status === 422;
  if (!overflowish || !httpish) return null;
  return { message: text, status };
}

module.exports = { parseOverflowNumbers, noteContextOverflow, getContextWindowOverride, isContextWindowOverrideAuthoritative, resetContextWindowOverrides, classifyContextOverflow };
