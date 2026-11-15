'use strict';

/** 归一化引用里的路径：统一正斜杠、去掉 ./ 前缀；Windows 下大小写不敏感。 */
function normalizeCitePath(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  while (p.startsWith('/')) p = p.slice(1);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 解析引用串：`path#Lx-Ly` → 行区间；`scalar:<key>` → 标量键；其它 → other。 */
function parseCitation(raw) {
  return require('./rag/citations.cjs').parseCitation(raw);
}

/**
 * 收集本轮「可信来源」——判据不只看检索返回值，而是本轮真实读过的内容：
 * - retrieve_context：文件来源的 path + startLine/endLine（块级范围）、标量来源的 scalar:<key>
 * - read_file：实际读到的行区间（offset/截断后的真实范围；无行号信息时按整文件）
 * - search_files：命中的具体行
 * - query_scalars：命中的标量 key
 * 这样「先检索、再按系统提示用 read_file 深读候选文件后引用」（系统提示第 11 条就是这么要求的）
 * 不会被误判成伪造引用；而本轮没读过、或行号与读到的范围完全不相交的引用仍判无效。
 */
function collectTrustedSources(toolCalls) {
  toolCalls = require('./rag/evidenceHistory.cjs').currentEvidenceCalls(toolCalls).calls;
  const ranges = new Map();
  const scalars = new Set();
  const citations = new Set();
  const addRange = (rawPath, start, end) => {
    const p = normalizeCitePath(rawPath);
    if (!p) return;
    const s = Math.max(1, Math.floor(Number(start)) || 1);
    const e = Math.max(s, Math.floor(Number(end)) || s);
    const list = ranges.get(p);
    if (list) list.push([s, e]);
    else ranges.set(p, [[s, e]]);
  };
  for (const call of toolCalls || []) {
    if (!call || call.ok === false || !call.data || typeof call.data !== 'object') continue;
    const data = call.data;
    if (call.name === 'retrieve_context') {
      for (const source of Array.isArray(data.sources) ? data.sources : []) {
        if (!source || !source.citation) continue;
        const raw = String(source.citation);
        citations.add(raw);
        const parsed = parseCitation(raw);
        if (parsed.kind === 'scalar') scalars.add(parsed.key);
        else if (parsed.kind === 'range') addRange(parsed.path, parsed.start, parsed.end);
        else if (source.path) addRange(source.path, source.startLine, source.endLine || Number.MAX_SAFE_INTEGER);
      }
    } else if (call.name === 'read_file') {
      if (data.binary === true) continue;
      const p = data.path || data.matched;
      if (!p) continue;
      if (Number.isFinite(Number(data.startLine)) && Number.isFinite(Number(data.endLine))) {
        addRange(p, data.startLine, data.endLine);
      } else {
        addRange(p, 1, Number(data.lineCount) || Number.MAX_SAFE_INTEGER);
      }
    } else if (call.name === 'search_files') {
      for (const line of Array.isArray(data.matches) ? data.matches : []) {
        const m = /^(.*?):(\d+):/.exec(String(line));
        if (m) addRange(m[1], Number(m[2]), Number(m[2]));
      }
    } else if (call.name === 'query_scalars') {
      for (const item of Array.isArray(data.items) ? data.items : []) {
        if (item && item.key) scalars.add(String(item.key));
      }
    }
  }
  return { ranges, scalars, citations };
}

/** 引用位置是否可追溯：标量按 key 命中；文件引用必须完整落在本轮读到的行区间内。 */
function citationTrusted(parsed, trusted) {
  if (parsed.kind === 'scalar') return trusted.scalars.has(parsed.key) || trusted.citations.has('scalar:' + parsed.key);
  if (parsed.kind === 'range') {
    const list = trusted.ranges.get(parsed.path);
    if (!list || !list.length) return false;
    let nextUnread = parsed.start;
    for (const [start, end] of [...list].sort((a, b) => a[0] - b[0])) {
      if (start > nextUnread) break;
      if (end >= nextUnread) nextUnread = end + 1;
      if (nextUnread > parsed.end) return true;
    }
    return false;
  }
  return false;
}

/** 校验最终回答中的引用位置（path#Lx-Ly 与 scalar:<key>）是否落在本轮真实读过的来源里。 */
function validateRagGrounding(content, toolCalls, options = {}) {
  const history = require('./rag/evidenceHistory.cjs').currentEvidenceCalls(toolCalls);
  toolCalls = history.calls;
  const allowed = new Set();
  let requiresCitation = false;
  for (const call of toolCalls || []) {
    if (!call || call.ok === false || call.name !== 'retrieve_context' || !call.data) continue;
    const sources = Array.isArray(call.data.sources) ? call.data.sources : [];
    for (const source of sources) {
      if (source && source.citation) allowed.add(String(source.citation));
    }
    // 只有文件型来源（path#Lx-Ly）才强制要求引用；纯标量精确命中无需强制（本身即精确数据）
    const hasFileSource = sources.some((s) => s.citation && !String(s.citation).startsWith('scalar:'));
    if (hasFileSource && sources.length && (!call.data.quality || call.data.quality.answerable !== false || call.data.quality.answerabilityStatus)) requiresCitation = true;
  }
  const trusted = collectTrustedSources(toolCalls);
  for (const key of trusted.scalars) allowed.add('scalar:' + key);
  for (const call of toolCalls || []) {
    if (call?.ok === false || call?.name !== 'read_file' || !call.data?.evidenceText) continue;
    const data = call.data;
    if (data.path && data.startLine > 0 && data.endLine >= data.startLine) {
      allowed.add(data.path + '#L' + data.startLine + '-L' + data.endLine);
      requiresCitation = true;
    }
  }
  if (allowed.size === 0 && !history.hadEvidence) {
    return { status: 'not_required', valid: true, required: false, allowed: [], used: [], invalid: [] };
  }
  const used = new Set(require('./rag/citations.cjs').extractCitations(content));
  const invalid = [];
  const validUsed = [];
  for (const citation of used) {
    if (citationTrusted(parseCitation(citation), trusted)) validUsed.push(citation);
    else invalid.push(citation);
  }
  let status = 'valid';
  if (invalid.length) status = 'invalid';
  else if (requiresCitation && validUsed.length === 0) status = 'missing';
  const semanticMode = options.semanticMode === 'warn' || options.semanticMode === 'enforce' ? options.semanticMode : 'off';
  // Synchronous citation validation cannot establish logical support.
  const semantic = semanticMode === 'off' ? { status: 'off', supported: null }
    : { status: 'pending', supported: false };
  return {
    status,
    valid: status === 'valid',
    required: requiresCitation,
    allowed: [...allowed],
    used: [...used],
    invalid,
    semantic,
  };
}

/** 引用校验提示文案：只作为独立事件上报，绝不拼进交付内容。 */
function groundingWarning(grounding) {
  if (grounding.status === 'invalid') {
    return 'RAG 来源校验：回答里有本轮未读到（路径未见或行号越界）的引用：' + grounding.invalid.join(', ') + '。请回到来源核对，不要把它们当作证据。';
  }
  if (grounding.status === 'missing') {
    return 'RAG 来源校验：本轮检索到了可用来源，但回答没有引用真实的 [path#Lx-Ly]；关键结论仍需回到来源核对。';
  }
  return '';
}

/**
 * enforce 模式下要求模型订正的提示（区分「引用伪造」与「有来源却没引用」两种不合格）。
 * 与 groundingWarning 一样，这段文字是**给模型的**，不会拼进交付给用户的内容。
 */
function groundingRetryPrompt(grounding) {
  if (grounding?.semantic?.supported === false && grounding.status === 'valid') {
    return '【系统提示】引用位置有效，但事实支持性校验未通过。请仅回答用户要求的核心事实，保留支持它们的真实引用。删除与问题无关或证据不足的扩展说明；缺少用户必需事实时补读对应源码或明确说明限制。不要输出校验过程、逐条自证清单、已读行数或重复撤回说明。核心结论不得因附加说明失败而丢失，附加说明也不得绕过校验。核对否定、数值、条件和跨文件关系。校验结果：' +
      JSON.stringify(grounding.semantic).slice(0, 5000);
  }
  if (grounding && grounding.status === 'invalid') {
    return (
      '【系统提示】你上一条回答里的引用在本轮没有来源（路径未读到或行号越界）：' +
      (grounding.invalid || []).join(', ') +
      '。请**只**依据本轮实际检索/读到的内容重写回答，不要编造引用；拿不到来源就如实说明。'
    );
  }
  return (
    '【系统提示】本轮已经检索到可用来源，但你的回答没有引用真实的 [path#Lx-Ly]。' +
    '请重写回答，并在关键结论处给出真实来源引用；不要凭空作答。'
  );
}

module.exports = { validateRagGrounding, groundingWarning, groundingRetryPrompt };
