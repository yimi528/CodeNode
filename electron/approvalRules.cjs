/**
 * approvalRules.cjs —— 持久化的审批规则（对照 Claude Code 的 allow 规则 / Codex 的项目 trust）
 *
 * 短板（对照文档 §5 #6）：审批令牌此前**只存内存、单次有效**，于是同一个工具要批准第 N 次 ——
 * 用户要么每次点（疲劳），要么干脆把 `tools.confirm_writes` 关掉（等于对所有写入放开）。
 * 中间那档「这个工具在本项目里我信它」不存在。
 *
 * 本模块提供「按动作记忆允许」的规则账本：
 *   - 文件：`<project>/.codenode/approvals.json`（**受保护路径**：写工具不能写它，见 shared.resolveInRoot）
 *   - v2 规则记录 executor、action、requiredCapability 和 level；原有 v1 规则保留，上限 50 条
 *   - 匹配：调用中的每个动作均须命中，同时核对执行器、能力和审批级别
 *   - 只对**注册表级**审批生效（那种 `what` 就是工具名）；shell 命令那种逐条确认**不记忆** ——
 *     因为「允许一条命令文本」很快就退化成「允许一类命令」，而 Windows 上没有内核兜底。
 *
 * 为什么必须把规则文件设为「写工具不可写」：模型如果能自己写这份文件，就等于**自己给自己发白名单**
 * （prompt injection 的一条现成路径）。规则只能由用户经界面按钮或手写文件产生。
 */
'use strict';

const fs = require('fs');
const { randomUUID } = require('node:crypto');
const path = require('path');
const { selectors } = require('./tools/actionRoutes.cjs');
const { withFileLock } = require('./fileLock.cjs');
const { atomicWriteFile } = require('./atomicFile.cjs');

const RULES_RELPATH = path.join('.codenode', 'approvals.json');
const MAX_RULES = 50;
/** 受保护路径（写工具一律拒绝）：这些文件是**授权面**，不能由 Agent 写 */
const PROTECTED_RELPATHS = [RULES_RELPATH, path.join('.codenode', 'permissions.json'), path.join('.codenode', 'session-overrides.json')];

function rulesFile(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), RULES_RELPATH);
}

/** 目标路径是否落在受保护清单里（相对项目根的任意写法都归一化后比较） */
function isProtectedWriteTarget(projectRoot, target) {
  let rel;
  try {
    rel = path.relative(path.resolve(projectRoot || '.'), path.resolve(target));
  } catch {
    return true;
  }
  const norm = rel.split(/[\\/]/).join('/');
  // A model must not forge completed/prepared records to bypass recovery review.
  if (/^\.codenode\/workflows(?:\/|$)/i.test(norm)) return true;
  return PROTECTED_RELPATHS.some((p) => p.split(/[\\/]/).join('/') === norm);
}

/** @returns {{version: number, rules: Array<any>, error?: string}} */
function readRules(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(rulesFile(projectRoot), 'utf8'));
    if (![1, 2].includes(parsed?.version ?? 1) || !Array.isArray(parsed?.rules)) {
      return { version: 2, rules: [], error: 'INVALID_RULES' };
    }
    return { version: parsed.version || 1, rules: parsed.rules };
  } catch (error) {
    return error.code === 'ENOENT' ? { version: 2, rules: [] } : { version: 2, rules: [], error: 'RULES_READ_FAILED' };
  }
}

function writeRules(projectRoot, rules) {
  const list = (Array.isArray(rules) ? rules : []).slice(-MAX_RULES);
  const file = rulesFile(projectRoot);
  atomicWriteFile(file, JSON.stringify({ version: 2, rules: list }, null, 2));
  return list;
}

// Single-action executors are unambiguous even for older service callers.
function approvalActions(tool, actionIds) {
  if (!tool) return [];
  const known = selectors(tool);
  if (actionIds === undefined) return known.length === 1 ? known : [];
  if (!Array.isArray(actionIds) || !actionIds.length || !actionIds.every(id => known.includes(id))) return [];
  return [...new Set(actionIds)];
}

/** @param {string} projectRoot
 * @param {{capability?: string|null, tool?: string|null, level?: string|null, source?: string, actionIds?: string[]}} rule */
function addRule(projectRoot, rule) {
  const tool = rule?.tool;
  if (!tool) return { ok: false, error: 'EMPTY_RULE' };
  const actions = approvalActions(tool, rule.actionIds);
  if (!actions.length) return { ok: false, error: 'ACTION_REQUIRED' };
  const requiredCapability = rule.capability || null;
  const level = rule.level ? String(rule.level).toUpperCase() : null;
  return withFileLock(rulesFile(projectRoot), () => {
    const stored = readRules(projectRoot);
    if (stored.error) return { ok: false, error: stored.error };
    const current = stored.rules;
    const confirmed = [];
    let changed = false;
    for (const action of actions) {
      const existing = current.find(r => r?.executor === tool && r.action === action &&
        r.requiredCapability === requiredCapability && r.level === level);
      if (existing) { confirmed.push(existing); continue; }
      changed = true;
      // Older readers ignore records without a v1 tool/capability, so cannot widen them.
      const id = randomUUID();
      confirmed.push({ id, executor: tool, action, requiredCapability, level,
        source: rule.source || 'user', createdAt: new Date().toISOString() });
    }
    // Keep the entire confirmed batch when evicting old rules at the size limit.
    const list = changed ? writeRules(projectRoot, [...current.filter(r => !confirmed.includes(r)), ...confirmed]) : current;
    return { ok: true, duplicate: !changed, id: confirmed[0].id, total: list.length };
  });
}

function matchingRules(rules, req) {
  const tool = req?.tool;
  const actions = approvalActions(tool, req?.actionIds);
  if (!actions.length || !Array.isArray(rules)) return [];
  const coverage = new Set();
  for (const action of actions) {
    const hit = rules.find(rule => {
      if (!rule || (rule.level && String(rule.level).toUpperCase() !== String(req.level || '').toUpperCase())) return false;
      if (Object.hasOwn(rule, 'action') || Object.hasOwn(rule, 'executor') || Object.hasOwn(rule, 'requiredCapability')) {
        return rule.executor === tool && rule.action === action &&
          (!rule.requiredCapability || rule.requiredCapability === req.capability);
      }
      // v1 tool names refer only to their original executor. The registry resolves
      // both invocation spellings before calling us, even for multi-action executors.
      return !!(rule.tool || rule.capability) && (!rule.tool || rule.tool === tool) &&
        (!rule.capability || rule.capability === req.capability);
    });
    if (!hit) return [];
    coverage.add(hit);
  }
  return [...coverage];
}

function matchRule(rules, req) {
  return matchingRules(rules, req)[0] || null;
}

/** 工具名形态（用于判断「这条审批能不能被记忆」：shell 命令文本不算） */
function isRememberableTool(tool) {
  return /^[a-z][a-z0-9_]{1,40}$/.test(String(tool || ''));
}

module.exports = {
  RULES_RELPATH,
  MAX_RULES,
  PROTECTED_RELPATHS,
  rulesFile,
  isProtectedWriteTarget,
  readRules,
  writeRules,
  addRule,
  matchRule,
  matchingRules,
  approvalActions,
  isRememberableTool,
};
