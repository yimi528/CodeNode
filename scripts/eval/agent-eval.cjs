#!/usr/bin/env node
/**
 * CodeNode Agent 真实多步评测 runner
 *
 * 目的：补上「真实多步工具任务 / 修改后跑测试 / 检索引用 / 长上下文压缩 / 提示注入 / 取消 /
 *       崩溃恢复 / 预算上限」的端到端评测，并用工作台真实终态判定，而不是只看模型自述。
 *
 * 两种模式：
 *   offline（默认，无网络、确定性）
 *     在 fetch 传输边界注入「脚本化 chat 客户端」：agent.runAgentChat → chatCompletionStream → fetch
 *     这条真实链路全部走通（工具循环、只读缓存、子代理压缩、取消、预算、runStore 事件），
 *     只有模型返回是可复现的脚本。工具、文件系统、shell、Run JSONL 都是真跑。
 *   model（真实模型，需显式配置）
 *     仅当设置了 CODENODE_EVAL_API_KEY 才启用；未配置时该模式显式 skipped，且以非 0 退出（fail-closed），
 *     不允许「无 Key 静默假绿」。真实模型模式只跑任务集里标记 realModel === true 的任务。
 *
 * 用法：
 *   node scripts/eval/agent-eval.cjs                        # 离线全量
 *   node scripts/eval/agent-eval.cjs --task=cancel-mid-run  # 只跑一个任务
 *   node scripts/eval/agent-eval.cjs --keep                 # 保留临时工作区便于排查
 *   node scripts/eval/agent-eval.cjs --mode=model --require-model
 *
 * 退出码：
 *   0  全部必需任务通过（模型模式未被要求时不适用）
 *   1  有必需任务失败 / 评测自身自检失败
 *   2  真实模型模式缺少必需凭据（fail-closed）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, "../..");
const agent = require("../../electron/agent.cjs");
const runStore = require("../../electron/runStore.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { GraphModel } = require("../../electron/tools/GraphModel.cjs");
const { getScalarStore } = require("../../electron/scalars/index.cjs");
const builtinDataset = require('./agent-eval-tasks.cjs');
const protocol = require('../lib/eval-protocol.cjs');
const { instrumentFetch } = require('../lib/eval-transport.cjs');
const { runQualityChecks, assessmentFor, summarizeAssessments, TRACK_LABELS } = require('../lib/eval-quality.cjs');
let datasetVersion=String(builtinDataset.datasetVersion);
/** @type {any[]} */ let TASKS=[...builtinDataset.tasks];
/** @type {Record<string,string[]>} */ let modelSubsets={...builtinDataset.modelSubsets};

const EXIT_OK = 0;
const EXIT_TASK_FAIL = 1;
const EXIT_MODEL_UNCONFIGURED = 2;

const DEFAULT_USAGE = { total_tokens: 120, prompt_tokens: 80, completion_tokens: 40 };
const WORKSPACE_IGNORE = ['.codenode', 'node_modules', '.git'];
const REPORT_DIR_REL = path.join('docs', 'eval-reports');

/* ------------------------------- 参数解析 ------------------------------- */

function parseArgs(argv) {
  const opts = { mode: 'offline', requireModel: false, allowModelSkip: false, keep: false, tasks: [], subsets: [], json: false, reportDir: null, baseline: null, cases: null };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--mode=offline') opts.mode = 'offline';
    else if (arg === '--mode=model') opts.mode = 'model';
    else if (arg.startsWith('--mode=')) throw new Error('未知 --mode：' + arg);
    else if (arg === '--require-model') opts.requireModel = true;
    else if (arg === '--allow-model-skip') opts.allowModelSkip = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--token-ledger=')) opts.tokenLedger = path.resolve(arg.slice(15));
    else if (arg === '--argv-guide') opts.argvGuide = true;
    else if (arg.startsWith('--grader-backend=')) opts.graderBackend = arg.slice(17);
    else if (arg === '--list') opts.list = true;
    else if (arg.startsWith('--task=')) opts.tasks.push(arg.slice('--task='.length));
    else if (arg.startsWith('--subset=')) opts.subsets.push(arg.slice('--subset='.length));
    else if (arg.startsWith('--cases=')) opts.cases=arg.slice('--cases='.length);
    else if (arg.startsWith('--baseline=')) opts.baseline = arg.slice('--baseline='.length);
    else if (arg.startsWith('--report-dir=')) opts.reportDir = arg.slice('--report-dir='.length);
    else throw new Error('未知参数：' + arg);
  }
  return opts;
}

/* ------------------------------- 小工具 ------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function gitInfo() {
  const run = (args) => {
    try {
      // The desktop sandbox may check out the repo as a different SID.  Scope
      // Git's trust exception to this exact eval root; never edit global config.
      const res = spawnSync('git', ['-c', 'safe.directory=' + path.resolve(ROOT), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
      return res.status === 0 ? String(res.stdout || '').trim() : '';
    } catch {
      return '';
    }
  };
  return {
    commit: run(['rev-parse', '--short', 'HEAD']) || 'nogit',
    fullCommit: run(['rev-parse', 'HEAD']) || 'nogit',
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'nogit',
    dirty: !!run(['status', '--porcelain']),
    codeFingerprint: runtimeFingerprint(),
  };
}

// Include uncommitted runtime sources in report identity without exporting source or secrets.
function runtimeFingerprint(){
 const hash=require('node:crypto').createHash('sha256');
 const visit=relative=>{const file=path.join(ROOT,relative),stat=fs.lstatSync(file);if(stat.isSymbolicLink())return;
  if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort())visit(path.join(relative,name));}
  else if(/\.(?:cjs|mjs|ts|tsx|json|jsonc|css)$/.test(relative)){hash.update(relative.replace(/\\/g,'/')+'\0');hash.update(fs.readFileSync(file));hash.update('\0');}
 };
 for(const name of ['electron','src','scripts','config','package.json'])visit(name);
 return hash.digest('hex');
}

/** 从工作台源码里取硬上限常量，报告里的参数必须来自真实代码而不是复述文档。 */
function sourceLimits() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'agent.cjs'), 'utf8');
    const iter = src.match(/MAX_TOOL_ITERATIONS\s*=\s*(\d+)/);
    const calls = src.match(/MAX_TOTAL_TOOL_CALLS\s*=\s*(\d+)/);
    return {
      maxToolIterations: iter ? Number(iter[1]) : null,
      maxTotalToolCalls: calls ? Number(calls[1]) : null,
      source: 'electron/agent.cjs',
    };
  } catch {
    return { maxToolIterations: null, maxTotalToolCalls: null, source: null };
  }
}

function listFiles(root, relative = '') {
  const out = [];
  const dir = path.join(root, relative);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relative ? relative + '/' + entry.name : entry.name;
    if (WORKSPACE_IGNORE.includes(entry.name)) continue;
    if (entry.name.endsWith('.bak')) continue;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function snapshotWorkspace(root) {
  const files = {};
  for (const rel of listFiles(root)) {
    try {
      files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      files[rel] = '<binary>';
    }
  }
  return files;
}

function diffWorkspace(before, after) {
  const changed = [];
  for (const [rel, content] of Object.entries(after)) {
    if (!(rel in before)) changed.push(rel + ' (新建)');
    else if (before[rel] !== content) changed.push(rel + ' (修改)');
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) changed.push(rel + ' (删除)');
  return changed.sort();
}

/* --------------------------- 脚本化 chat 客户端 --------------------------- */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

function sse(data) {
  return 'data: ' + JSON.stringify(data) + '\n\n';
}

function toolCallsDelta(calls) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id || 'call_' + index,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          })),
        },
      },
    ],
  };
}

function sseForStep(step, usage) {
  let out = '';
  if (step.tools && step.tools.length) {
    out += sse(toolCallsDelta(step.tools));
  } else if (step.tool) {
    out += sse(toolCallsDelta([{ name: step.tool, args: step.args }]));
  } else {
    out += sse({ choices: [{ index: 0, delta: { content: String(step.content || '（无内容）') } }] });
  }
  out += sse({ choices: [], usage });
  out += 'data: [DONE]\n\n';
  return out;
}

function describeStep(step) {
  if (step.tools) return step.tools.map((t) => t.name).join('+');
  if (step.tool) return step.tool;
  return 'content';
}

/**
 * 脚本化传输：替换 global.fetch。
 * - body.stream === true  → 主循环的一步（按 script 顺序回放）
 * - body.stream !== true  → 子代理压缩等非流式调用（返回确定性摘要，不消耗 script 步数）
 * 任何非评测目标的网络地址都会被记录为 unexpected（用于「离线模式没有真实联网」自检）。
 */
function createScriptedTransport(/** @type {{ task: any, apiBase: string, onStep?: Function }} */ { task, apiBase, onStep }) {
  const usage = { ...DEFAULT_USAGE, ...(task.usage || {}) };
  const stats = { streamRequests: 0, nonStreamRequests: 0, unexpectedUrls: [], steps: [], exhausted: 0 };
  let mainStep = 0;

  async function fetchImpl(url, init) {
    const urlStr = typeof url === 'string' ? url : String(url && url.url ? url.url : url);
    if (!urlStr.startsWith(apiBase)) {
      stats.unexpectedUrls.push(urlStr);
      return jsonResponse({ error: '离线评测模式禁止访问：' + urlStr }, 403);
    }
    let body = {};
    try {
      body = JSON.parse((init && init.body) || '{}');
    } catch {}
    if (!body.stream) {
      stats.nonStreamRequests++;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userMsg = messages.find((m) => m.role === 'user') || { content: '' };
      const raw = String(userMsg.content || '');
      const summary = '【脚本压缩】原始 ' + raw.length + ' 字符 → 保留要点：\n' + raw.slice(0, 90);
      return jsonResponse({ choices: [{ message: { content: summary } }], usage });
    }
    stats.streamRequests++;
    const step = task.script[mainStep];
    mainStep++;
    if (!step) {
      stats.exhausted++;
      stats.steps.push('script-exhausted');
      return sseResponse(sse({ choices: [{ index: 0, delta: { content: '（脚本已耗尽，评测脚本回合不足）' } }] }) + sse({ choices: [], usage }) + 'data: [DONE]\n\n');
    }
    stats.steps.push(describeStep(step));
    if (onStep) onStep({ index: mainStep, step, stats });
    if (step.error) return jsonResponse({ error: step.error }, 500);
    return sseResponse(sseForStep(step, usage));
  }

  return { fetchImpl, stats };
}

/* ------------------------------ 引用占位符 ------------------------------ */

function collectCitations(records) {
  const out = [];
  for (const record of records) {
    if (record.name !== 'retrieve_context') continue;
    const sources = (record.data && Array.isArray(record.data.sources) && record.data.sources) || [];
    for (const source of sources) {
      if (source && source.citation) out.push(String(source.citation));
    }
  }
  return out;
}

function interpolate(text, citations) {
  const fileOnes = citations.filter((c) => !c.startsWith('scalar:'));
  return String(text == null ? '' : text).replace(/\{\{source(?::(\d+))?\}\}/g, (_m, idx) => {
    const list = fileOnes.length ? fileOnes : citations;
    const i = idx == null ? 0 : Number(idx);
    return list[i] || '（无可用来源）';
  });
}

/* -------------------------------- 断言检查 -------------------------------- */

/**
 * 每个检查函数返回 { pass, detail }。
 * 全部基于「工作台真实终态」：文件字节 / 工具层返回 / Run JSONL / 独立复跑退出码。
 */
function buildChecks(ctx) {
  const records = () => ctx.result.toolCalls || [];
  const byTool = (name) => records().filter((r) => r.name === name);
  const workspacePath = (rel) => path.resolve(ctx.workspace, rel);

  return {
    'file-exact': check => ({pass:fs.readFileSync(workspacePath(check.path),'utf8')===check.text,detail:'文件完整字节比较'}),
    'git-user-dirty': check => {const result=spawnSync('git',['status','--porcelain','--',check.path],{cwd:ctx.workspace,encoding:'utf8'});return {pass:result.status===0&&result.stdout.includes(check.path),detail:result.stdout};},
    'steering-injected': () => ({pass:ctx.result.steeringInjected>0,detail:'steeringInjected='+ctx.result.steeringInjected}),
    'verification-revalidated': () => ({pass:ctx.injectedMutation&&ctx.result.codeVerification?.verified===true&&ctx.verificationReports>=2,detail:'外部修改已注入；最终证据必须重新生成，不能复用旧通过状态'}),
    'registry-excludes': (check) => ({
      pass: !ctx.registry.contains(check.tool),
      detail: `工具注册表 ${ctx.registry.contains(check.tool) ? '仍包含' : '已排除'} ${check.tool}`,
    }),
    'registry-includes': (check) => ({
      pass: ctx.registry.contains(check.tool),
      detail: `工具注册表 ${ctx.registry.contains(check.tool) ? '包含' : '缺少'} ${check.tool}`,
    }),
    'tool-ok': (check) => {
      const hit = byTool(check.tool).filter((r) => r.ok);
      return { pass: hit.length >= (check.min || 1), detail: `${check.tool} 成功调用 ${hit.length} 次` };
    },
    'tool-failed': (check) => {
      const hit = byTool(check.tool).filter((r) => !r.ok);
      return { pass: hit.length >= (check.min || 1), detail: `${check.tool} 失败调用 ${hit.length} 次（期望 ≥${check.min || 1}）` };
    },
    'tool-called': (check) => {
      const n = byTool(check.tool).length;
      const min = check.min == null ? 1 : check.min;
      const max = check.max == null ? Infinity : check.max;
      return { pass: n >= min && n <= max, detail: `${check.tool} 调用次数 ${n}（期望 ${min}..${max}）` };
    },
    'tool-not-called': (check) => {
      const n = byTool(check.tool).length;
      return { pass: n === 0, detail: `${check.tool} 调用次数 ${n}（期望 0）` };
    },
    'tool-data-match': (check) => {
      const hit = byTool(check.tool).filter((r) => r.data && r.data[check.key] === check.value);
      return { pass: hit.length > 0, detail: `${check.tool}.data.${check.key} === ${JSON.stringify(check.value)} 命中 ${hit.length} 次` };
    },
    'tool-success-output': (check) => {
      const hit = byTool(check.tool).filter(r => r.ok && r.data?.exitCode === 0 && String(r.result || '').includes(check.text));
      return { pass: hit.length > 0, detail: `${check.tool} 退出成功且输出包含「${check.text}」：${hit.length} 次（过程信号）` };
    },
    'tool-result-contains': (check) => {
      const hit = byTool(check.tool).filter((r) => String(r.result || '').includes(check.text));
      return { pass: hit.length > 0, detail: `${check.tool} 返回文本包含「${check.text}」${hit.length ? '是' : '否'}` };
    },
    'tool-results-not-contains': (check) => {
      const hit = records().filter((r) => String(r.result || '').includes(check.text));
      return { pass: hit.length === 0, detail: `工具返回中「${check.text}」出现 ${hit.length} 次（期望 0）` };
    },
    'file-exists': (check) => ({ pass: fs.existsSync(workspacePath(check.path)), detail: `${check.path} 存在=${fs.existsSync(workspacePath(check.path))}` }),
    'file-missing': (check) => ({ pass: !fs.existsSync(workspacePath(check.path)), detail: `${check.path} 存在=${fs.existsSync(workspacePath(check.path))}（期望不存在）` }),
    'file-contains': (check) => {
      let content = null;
      try {
        content = fs.readFileSync(workspacePath(check.path), 'utf8');
      } catch {}
      const ok = content != null && content.includes(check.text);
      return { pass: ok, detail: `${check.path} 包含「${check.text}」=${ok}` };
    },
    'file-not-contains': (check) => {
      let content = null;
      try {
        content = fs.readFileSync(workspacePath(check.path), 'utf8');
      } catch {}
      const ok = content != null && !content.includes(check.text);
      return { pass: ok, detail: `${check.path} 仍含「${check.text}」=${content != null && content.includes(check.text)}（期望否）` };
    },
    'path-missing': (check) => {
      const full = path.resolve(ctx.workspace, check.path);
      return { pass: !fs.existsSync(full), detail: `${full} 存在=${fs.existsSync(full)}（期望不存在）` };
    },
    'workspace-changes': (check) => {
      const changed = diffWorkspace(ctx.before, ctx.after);
      const expect = (check.expect || []).slice().sort();
      const normalize = (list) => list.map((item) => String(item).replace(/\s*\((新建|修改|删除)\)$/, '')).sort();
      const ok = JSON.stringify(normalize(changed)) === JSON.stringify(normalize(expect));
      return { pass: ok, detail: `工作区变更=[${changed.join(', ') || '无'}] 期望=[${expect.join(', ') || '无'}]` };
    },
    'steps-at-most': (check) => ({
      pass: ctx.modelSteps <= check.max,
      detail: `模型步数 ${ctx.modelSteps} ≤ ${check.max}`,
    }),
    'delta-kind': (check) => {
      const n = ctx.deltas.filter((d) => d && d.kind === check.kind).length;
      return { pass: n >= (check.min || 1), detail: `onDelta kind=${check.kind} 出现 ${n} 次（期望 ≥${check.min || 1}）` };
    },
    compressed: (check) => {
      const hit = byTool(check.tool).filter((r) => r.compressed);
      return { pass: hit.length >= (check.min || 1), detail: `${check.tool} 触发子代理压缩 ${hit.length} 次（期望 ≥${check.min || 1}）` };
    },
    'compressed-ratio': (check) => {
      const hit = byTool(check.tool).filter((r) => r.compressedChars && r.compressedChars.from > 0);
      if (!hit.length) return { pass: false, detail: `${check.tool} 没有压缩记录` };
      const worst = Math.max(...hit.map((r) => r.compressedChars.to / r.compressedChars.from));
      // 判据自带证据：只报「最大比 0.692」看不出是「原文太小导致比值天然偏高」还是「模型没守字符预算」。
      const rows = hit
        .map((r) => ({ from: r.compressedChars.from, to: r.compressedChars.to, ratio: r.compressedChars.to / r.compressedChars.from }))
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 3)
        .map((r) => `${r.from}→${r.to}(${r.ratio.toFixed(3)})`);
      return {
        pass: worst <= check.maxRatio,
        detail: `压缩后/前 最大比 ${worst.toFixed(3)}（期望 ≤${check.maxRatio}）；压缩记录 ${hit.length} 条，最大的几条：${rows.join(' / ')}`,
      };
    },
    'context-bounded': (check) => {
      const nonSystem = ctx.messages.filter((m) => m.role !== 'system');
      const longest = nonSystem.reduce((max, m) => Math.max(max, String(m.content || '').length), 0);
      // 判据必须自带证据：只报「最长 9099 字符」没法定位是**工具结果**没被压缩、还是模型自己回了长文
      // （前者是 harness 缺陷，后者只是模型啰嗦 —— 处理方式完全不同）。所以把角色 + 片段一起报出来。
      const worst = nonSystem
        .map((m) => ({ role: String(m.role || '?'), len: String(m.content || '').length, name: m.name || m.tool_call_id || '', head: String(m.content || '').slice(0, 60).replace(/\s+/g, ' ') }))
        .sort((a, b) => b.len - a.len)[0];
      const where = worst ? `；最长者为 role=${worst.role}${worst.name ? '(' + worst.name + ')' : ''}，开头「${worst.head}」` : '';
      return { pass: longest <= check.maxChars, detail: `上下文中最长非 system 消息 ${longest} 字符（上限 ${check.maxChars}）${where}` };
    },
    'citation-source': (check) => {
      const pattern = new RegExp(check.pattern);
      const hits = ctx.citations.filter((c) => pattern.test(c));
      return { pass: hits.length >= (check.min || 1), detail: `召回文件引用 ${hits.length} 条（期望 ≥${check.min || 1}）：${hits.slice(0, 3).join(' | ')}` };
    },
    'grounding-status': (check) => {
      const text = interpolate(check.use, ctx.citations);
      const grounding = agent.validateRagGrounding(text, records());
      return { pass: grounding.status === check.expect, detail: `引用校验 status=${grounding.status}（期望 ${check.expect}），文本片段「${text.slice(0, 80)}」` };
    },
    'error-contains': (check) => ({
      pass: String(ctx.result.error || '').includes(check.text),
      detail: `result.error=${JSON.stringify(String(ctx.result.error || '').slice(0, 160))} 含「${check.text}」=${String(ctx.result.error || '').includes(check.text)}`,
    }),
    'stop-reason': (check) => ({ pass: ctx.result.stopReason === check.value, detail: `stopReason=${ctx.result.stopReason}（期望 ${check.value}）` }),
    aborted: (check) => ({ pass: !!ctx.result.aborted === check.value, detail: `aborted=${!!ctx.result.aborted}（期望 ${check.value}）` }),
    'run-status': (check) => {
      const status = runStore.summarizeRun(runStore.readRun(ctx.workspace, ctx.runId)).status;
      return { pass: status === check.value, detail: `Run 状态=${status}（期望 ${check.value}）` };
    },
    'run-event': (check) => {
      const events = runStore.readRun(ctx.workspace, ctx.runId).filter((e) => e.type === check.event);
      const min = check.min == null ? 0 : check.min;
      const max = check.max == null ? Infinity : check.max;
      return { pass: events.length >= min && events.length <= max, detail: `Run 事件 ${check.event} 共 ${events.length} 条（期望 ${min}..${max}）` };
    },
    'crash-recovery': (check) => {
      // 只读断言：崩溃留下的 Run 事件 → 恢复扫描 → 续跑计划 → 重试标记，全部走 runStore 真实接口
      const recovered = runStore.recoverInterrupted(ctx.workspace);
      const recoveredEvents = runStore.readRun(ctx.workspace, ctx.runId).filter((e) => e.type === 'run_recovered').length;
      const plan = runStore.resumePlan(ctx.workspace, ctx.runId);
      const toolNames = (plan.completedToolNames || []).slice();
      const replacement = 'eval-replacement-' + Date.now().toString(36);
      const retry = runStore.markRetry(ctx.workspace, ctx.runId, replacement);
      const statusAfter = runStore.summarizeRun(runStore.readRun(ctx.workspace, ctx.runId)).status;
      const missing = (check.expectToolNames || []).filter((name) => !toolNames.includes(name));
      const pass =
        recovered.length === check.expectRecovered &&
        recoveredEvents >= 1 &&
        plan.ok === check.expectResumePlan &&
        plan.requiresReview === true &&
        missing.length === 0 &&
        retry.ok === true &&
        statusAfter === 'superseded';
      return {
        pass,
        detail:
          `恢复扫描恢复 ${recovered.length} 个 Run（期望 ${check.expectRecovered}）；run_recovered=${recoveredEvents}；` +
          `resumePlan.ok=${plan.ok}；已完成工具=[${toolNames.join(', ')}]（缺 ${missing.join(', ') || '无'}）；` +
          `markRetry.ok=${retry.ok}；重试后状态=${statusAfter}`,
      };
    },
    'coding-behavior': () => require('../lib/coding-grader.cjs').gradeCoding(ctx.workspace, ctx.task, { backend: ctx.graderBackend || 'process' }),
    'verify-shell': (check) => {
      // 评测进程独立复跑（不采信模型自述，也不只信工具返回）
      const res = spawnSync(check.command, { cwd: ctx.workspace, shell: true, encoding: 'utf8', timeout: check.timeoutMs || 60000 });
      const stdout = String(res.stdout || '');
      const ok = res.status === 0 && (!check.expect || stdout.includes(check.expect));
      return {
        pass: ok,
        detail: `独立复跑「${check.command}」exit=${res.status}，输出含「${check.expect}」=${stdout.includes(String(check.expect || ''))}；输出=${JSON.stringify(stdout.trim().slice(0, 120))}`,
      };
    },
  };
}

/* --------------------------------- 单任务 --------------------------------- */

function writeFixtures(workspace, fixture) {
  for (const [rel, content] of Object.entries(fixture || {})) {
    const file = path.resolve(workspace, rel), relative=path.relative(workspace,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||relative.split(path.sep).includes('.git'))throw Error('fixture 路径越界');
    for(let current=file;current!==workspace;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('fixture 不能穿过符号链接');}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(content), 'utf8');
  }
}

// 真机/离线两套口径（预算 / 配置覆盖 / 判据）住在 scripts/lib/eval-limits.cjs ——
// 抽出去是为了能**离线单测**（不需要真机 Key），并且让「只许放宽 steps-at-most」的白名单在
// **运行时**也生效（写错的人另有 scripts/core/real-model-pr-test.cjs 直接判红）。
const { effectiveBudget, effectiveOverride, effectiveChecks } = require("../lib/eval-limits.cjs");

function buildConfig(task, workspace, opts) {
  const mode = opts.mode;
  const modelCfg = opts.modelCfg;
  const cfg = agent.loadConfig(workspace);
  const override = effectiveOverride(task, mode);
  const budget = effectiveBudget(task, mode);
  cfg.apiBase = mode === 'model' ? modelCfg.apiBase : 'https://scripted.eval.local/v1';
  cfg.apiKey = mode === 'model' ? modelCfg.apiKey : 'scripted-eval-key';
  cfg.model = mode === 'model' ? modelCfg.model : 'scripted-eval/' + task.id;
  // 协议只在真机档生效：脚本化档走内置 stub（OpenAI 形状），别被 env 带偏
  if (mode === 'model') {
    const protocolLib = require("../../electron/modelProtocol.cjs");
    cfg.protocol = protocolLib.normalizeProtocol(modelCfg.protocol || cfg.protocol);
    cfg.auth = String(modelCfg.auth || cfg.auth || 'auto');
    cfg.endpoint = String(modelCfg.endpoint || cfg.endpoint || 'standard');
  }
  cfg.maxTokens = 4096;
  cfg.reasoningEffort = 'low';
  // 评测内重试固定为 1、且不做流式中断重发：脚本化传输的失败必须确定性可判定
  // （新配置项显式补齐，避免「继承了生产默认值」把评测判据悄悄改掉）。
  cfg.reliability = { ...agent.loadConfig(null).reliability, maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20, streamMaxAttempts: 0 };
  // 评测内的脚本化传输必须确定性：**关掉上下文压缩**（否则脚本化模型会多收到一次摘要请求，
  // 打乱 `steps-at-most` 与脚本轮次的对齐）。压缩本身由 scripts/core/compaction-test.cjs 单独锁。
  cfg.compaction = { ...agent.loadConfig(null).compaction, enabled: false };
  if (override.compression) cfg.compression = { ...cfg.compression, ...override.compression };
  if (override.limits) cfg.limits = { ...cfg.limits, ...override.limits };
  if (budget && budget.maxTotalTokens) {
    cfg.limits = { ...cfg.limits, maxTotalTokens: budget.maxTotalTokens };
  }
  if(task.editing)cfg.editing={...cfg.editing,...task.editing};
  if(task.verification)cfg.editing={...cfg.editing,lintCommand:'node --check {files}',testCommand:'node test.cjs',maxVerificationRuns:5};
  const RequestBudget = require("../../electron/requestBudget.cjs").RequestBudget;
  cfg.requestBudget = new RequestBudget(task.requestBudgetTokens || (budget && budget.maxTotalTokens) || cfg.limits.maxTotalTokens);
  return cfg;
}

async function runTask(task, opts) {
  const started = Date.now();
  const budget = effectiveBudget(task, opts.mode);
  const record = {
    id: task.id,
    title: task.title,
    category: task.category,
    required: task.required !== false,
    status: 'fail',
    reason: null,
    allowTools: task.allowTools,
    budget,
    durationMs: 0,
    modelSteps: 0,
    toolCalls: 0,
    checks: [],
    failed: [],
  };

  if (opts.mode === 'model' && task.realModel !== true) {
    record.status = 'skipped';
    // 逐任务给出**具体**的跳过理由（`modelSkipReason`）；没写就退回通用说明。
    // 「为什么这个任务不能真机跑」必须是任务自己声明的事实，而不是一句模板 ——
    // 否则下一个人只能靠猜，也就无从判断它该不该补上真机覆盖。
    record.reason = task.modelSkipReason || '该任务依赖脚本化模型（确定性注入/预算/取消/崩溃），真实模型模式不适用';
    record.durationMs = Date.now() - started;
    return record;
  }

  const evidence = protocol.createTrial(opts.evidenceRoot, task, { mode: opts.mode, profile: 'benchmark-controlled', agent: opts.agentIdentity, evaluation: task.evaluation }, [opts.modelCfg.apiKey]);
  opts.trials.set(task.id, evidence);
  record.evidence = { trialId: evidence.trialId, directory: evidence.directory };
  evidence.save('execution.json', { phase: 'PREPARING', executionStatus: 'NOT_STARTED', gradingStatus: 'NOT_RUN', integrityStatus: 'UNKNOWN' });
  const workspace = fs.mkdtempSync(path.join(opts.workRoot, 'eval-' + task.id + '-'));
  record.workspace = workspace;
  if(task.repository)record.repository=require('../lib/eval-repository.cjs').materialize(task.repository,workspace);
  writeFixtures(workspace, task.fixture);
  if(task.gitBaseline){for(const args of [['init'],['add','.'],['-c','user.name=Eval','-c','user.email=eval@localhost','commit','-m','baseline']]){const out=spawnSync('git',args,{cwd:workspace,encoding:'utf8'});if(out.status!==0)throw Error('评测 Git 基线失败：'+out.stderr);}}
  if(task.userDirty)writeFixtures(workspace,task.userDirty);
  const before = snapshotWorkspace(workspace);

  const cfg = buildConfig(task, workspace, opts);
  const registry = toolkit.buildDefaultRegistryWithConfig({
    toolsEnabled: true,
    toolsAllowed: task.allowTools,
    ragEnabled: true,
    projectRoot: workspace,
  });
  if (task.injectFailure) {
    const original = registry.execute.bind(registry);
    let remaining = task.injectFailure.count || 1;
    registry.execute = async (name, args, ctx) => {
      if (name === task.injectFailure.tool && remaining > 0) {
        remaining--;
        evidence.append('events.jsonl', { kind: 'injected_tool_failure', tool: name, remaining });
        return { ok: false, text: '临时读取故障，请修正或重试；本提示是评测注入。', data: { code: 'EVAL_TEMPORARY_FAILURE' } };
      }
      return original(name, args, ctx);
    };
  }
  const effective = {};
  for (const key of ['apiBase','model','protocol','auth','endpoint','maxTokens','reasoningEffort','limits','tools','compression','compaction','reliability','editing','externalVerification']) effective[key] = cfg[key];
  evidence.save('effective-config.json', { profile: 'benchmark-controlled', values: effective, budget, graderBackend: opts.graderBackend || 'process', argvGuide: !!opts.argvGuide, approvalMode: 'auto-approve-fixture' });
  const model = new GraphModel();
  const controller = new AbortController();
  const runId = runStore.normalizeRunId('eval-' + task.id);
  cfg.costRunId=runId;
  cfg.costLedger = new (require('../../electron/costLedger.cjs').CostLedger)({projectRoot:workspace,runId,prices:cfg.costPrices});
  let approvalRequests=0, inputRequests=0, steerQueued=false, injectedMutation=false, firstVerificationFingerprint=null, verificationReports=0;
  const steerQueue=[];
  const deltas = [];
  const messages = [];

  const context = new AgentToolContext({
    projectRoot: workspace,
    model,
    runId,
    role: 'supervisor',
    signal: controller.signal,
    scalarStore: getScalarStore(workspace),
    // 评测自动批准写操作：确认交互不属于本任务判据（路径边界/敏感文件由工具层独立拦截）
    confirm: async () => {approvalRequests++;return true;},
    audit: (entry) => runStore.appendEvent(workspace, runId, 'audit', { entry: String(entry || '').slice(0, 2000) }),
    mutateWorkbench: async (fn) => {
      fn(model);
      return true;
    },
    saveProject: async () => null,
    askUser: async () => {inputRequests++;return '';},
    ui: async () => false,
    conversationHistory: () => [],
    notifyFileChange: () => {},
    ragConfig: cfg.rag,
  });

  const soul = agent.parseSoul(agent.loadSoul(cfg, workspace));
  const toolGuide = agent.buildToolGuide(registry.listTools());
  messages.push({ role: 'system', content: agent.buildSystemPrompt(soul, '', toolGuide, '', '') });
  if (opts.argvGuide) messages[0].content += '\n' + require('../../electron/benchmarkProfile.cjs').ARGV_GUIDE;
  messages.push({ role: 'user', content: task.prompt });

  let toolResultCount = 0;
  let crashed = false;
  let cancelArmed = !!task.cancelAfter;
  const onDelta = (delta) => {
    if (!delta || !delta.kind) return;
    if(delta.kind==='code_verification'&&delta.codeVerification?.verified)verificationReports++;
    if(task.mutateAfterVerification&&!injectedMutation&&delta.kind==='code_verification'&&delta.codeVerification?.verified){
      firstVerificationFingerprint=delta.codeVerification.fingerprint;injectedMutation=true;
      fs.writeFileSync(path.join(workspace,task.mutateAfterVerification.path),task.mutateAfterVerification.content);
      steerQueue.push('工作区文件刚被外部修改，请重新读取、修复和验证；旧校验不能代表当前代码。');
    }
    deltas.push(delta);
    evidence.append('events.jsonl', delta);
    // 与 electron/main.cjs 的 agent:chat 保持一致：把本轮关键事件写进 Run JSONL
    if (delta.kind === 'tool_result' && Array.isArray(delta.toolCalls)) {
      runStore.appendEvent(workspace, runId, 'tool_result', {
        tools: delta.toolCalls.map((item) => ({ name: item && item.name, ok: item && item.ok, elapsedMs: item && item.elapsedMs })),
      });
      toolResultCount += delta.toolCalls.length;
      if(task.steerAfter&&!steerQueued&&delta.toolCalls.some(item=>item.name===task.steerAfter.tool)){steerQueued=true;steerQueue.push(task.steerAfter.text);}
      // 取消判据（离线模式）：第 N 次目标工具结果返回后取消运行
      if (cancelArmed && task.cancelAfter) {
        const matched = (task.cancelAfter.tool == null || delta.toolCalls.some((item) => item && item.name === task.cancelAfter.tool));
        if (matched && toolResultCount >= (task.cancelAfter.count || 1)) {
          cancelArmed = false;
          controller.abort();
        }
      }
      // 崩溃判据：到达既定工具结果数后中止且不写 run_finish（等同于进程被杀）
      if (task.simulateCrash && toolResultCount >= (task.crashAfterToolCall || 1)) {
        crashed = true;
        controller.abort();
      }
    } else if (['start', 'error', 'stopped', 'done'].includes(delta.kind)) {
      runStore.appendEvent(workspace, runId, delta.kind, { error: delta.error || null });
    }
  };

  let transport = null;
  const originalFetch = global.fetch;
  if (opts.mode === 'offline') {
    transport = createScriptedTransport({ task, apiBase: cfg.apiBase });

  }

  global.fetch = instrumentFetch(transport ? transport.fetchImpl : originalFetch, evidence, { apiBase: cfg.apiBase, ledger: opts.mode === 'model' ? opts.tokenLedger : null });
  evidence.save('execution.json', { phase: 'SOLVING', executionStatus: 'UNKNOWN', gradingStatus: 'NOT_RUN', integrityStatus: 'UNKNOWN' });
  let timer = null;
  if (opts.mode === 'model' && task.cancelAfterMs) {
    timer = setTimeout(() => controller.abort(), task.cancelAfterMs);
  }

  runStore.startRun(workspace, runId, { prompt: String(task.prompt).slice(0, 4000), model: cfg.model });
  agent.logConversation(workspace, { ts: nowIso(), role: 'user', content: task.prompt, nodeId: null });

  let watchdogFired = false;
  const watchdogMs = (budget && budget.timeoutMs ? budget.timeoutMs : 60000) + 20000;
  const runPromise = agent
    .runAgentChat({
      cfg,
      messages,
      onDelta,
      tools: { registry, context },
      signal: controller.signal,
      timeoutMs: budget && budget.timeoutMs ? budget.timeoutMs : 60000,
      steering: {drain:()=>steerQueue.splice(0)},
    })
    .catch((error) => ({ error: String((error && error.message) || error), toolCalls: [], aborted: controller.signal.aborted }));

  let result = await Promise.race([
    runPromise,
    new Promise((resolve) =>
      setTimeout(() => {
        watchdogFired = true;
        controller.abort();
        resolve({ error: '评测看门狗超时（任务未在预算时间内结束）', toolCalls: [], aborted: true });
      }, watchdogMs)
    ),
  ]);
  if (watchdogFired) {
    // 给被取消的循环一点时间落盘事件，避免报告与磁盘状态不一致
    try {
      result = await Promise.race([runPromise, new Promise((resolve) => setTimeout(() => resolve(result), 3000))]);
    } catch {}
  }
  if (timer) clearTimeout(timer);
  global.fetch = originalFetch;

  if (!crashed && !watchdogFired) {
    runStore.finishRun(workspace, runId, result.error ? 'error' : result.aborted ? 'cancelled' : 'completed', {
      toolCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      usage: result.usage || null,
      error: result.error || null,
    });
  }
  agent.logConversation(workspace, {
    ts: nowIso(),
    role: 'assistant',
    content: result.content || '',
    toolCalls: result.toolCalls || null,
    usage: result.usage || null,
  });

  const after = snapshotWorkspace(workspace);
  const ctx = {
    task,
    workspace,
    cfg,
    registry,
    context,
    controller,
    result,
    deltas,
    messages,
    runId,
    before,
    after,
    modelSteps: transport ? transport.stats.streamRequests : Number(result && result.iterations),
    citations: collectCitations(result.toolCalls || []),
    injectedMutation, firstVerificationFingerprint, verificationReports,
    transport,
    graderBackend: opts.graderBackend || 'process',
  };

  const checkers = buildChecks(ctx);
  for (const check of effectiveChecks(task, opts.mode)) {
    const fn = checkers[check.type];
    const name =
      check.type +
      (check.tool ? '(' + check.tool + ')' : '') +
      (check.path ? '(' + check.path + ')' : '') +
      (check.event ? '(' + check.event + ')' : '') +
      (check.expect != null ? '(' + check.expect + ')' : '') +
      (check.text ? '(「' + check.text + '」)' : '');
    if (!fn) {
      record.checks.push({ name, type: check.type, pass: false, detail: '未知检查类型' });
      record.failed.push(name + ' → 未知检查类型');
      continue;
    }
    let outcome;
    try {
      outcome = fn(check);
    } catch (error) {
      outcome = { pass: false, detail: '检查抛错：' + String((error && error.message) || error) };
    }
    record.checks.push({ name, type: check.type, pass: !!outcome.pass, detail: outcome.detail, status: outcome.status || (outcome.pass ? 'PASS' : 'FAIL'), integrityStatus: outcome.integrityStatus });
    if (!outcome.pass) record.failed.push(name + ' → ' + outcome.detail);
  }

  record.observations = (task.observations || []).map(check => {
    let outcome;
    try { outcome = checkers[check.type](check); }
    catch (error) { outcome = { pass: false, detail: String(error.message || error) }; }
    return { type: check.type, tool: check.tool, pass: !!outcome.pass, detail: outcome.detail };
  });

  if (watchdogFired) record.failed.unshift('评测看门狗超时（' + watchdogMs + 'ms）');
  if (transport && transport.stats.unexpectedUrls.length) {
    record.failed.unshift('离线模式出现非预期网络地址：' + transport.stats.unexpectedUrls.join(', '));
  }
  if (transport && transport.stats.exhausted) {
    record.failed.unshift('脚本回合不足：模型又请求了 ' + transport.stats.exhausted + ' 次');
  }

  // fail-closed：判据（steps-at-most）依赖模型步数，取不到就显式判失败，绝不当成 0 ——
  // 0 会让「模型步数 ≤ N」永远通过，等于判据消失（此前真实模型模式数的是 SSE 分片数，虚高 20 倍，门禁恒红）。
  if (!Number.isFinite(ctx.modelSteps)) {
    record.failed.unshift('无法确定模型步数（runAgentChat 返回值缺 iterations）');
  }
  record.modelSteps = ctx.modelSteps;
  const costs=cfg.costLedger.summary(runId);
  record.metrics={approvalRequests, inputRequests, injectedUserChanges:result.steeringInjected||0, humanInterventions:inputRequests, tokens:costs.totalTokens, costUsd:opts.mode==='model'&&costs.costKnown?costs.costUsd:null, costKnown:opts.mode==='model'&&costs.costKnown, mode:opts.mode};
  record.toolCalls = (result.toolCalls || []).length;
  record.toolSequence = (result.toolCalls || []).map((r) => r.name + (r.ok ? '' : '!' ) + (r.compressed ? '~' : '')).join(' → ');
  record.runStatus = runStore.summarizeRun(runStore.readRun(workspace, runId)).status;
  record.error = result.error || null;
  record.aborted = !!result.aborted;
  record.finalReply = String(result.content || '').slice(0, 400);
  if (transport) record.transport = { streamRequests: transport.stats.streamRequests, compressionRequests: transport.stats.nonStreamRequests, scriptSteps: transport.stats.steps };
  record.status = record.failed.length ? 'fail' : 'pass';
  record.durationMs = Date.now() - started;

  const executionStatus = protocol.classifyExecution(result, { watchdog: watchdogFired, deadlineExceeded: !!result.error && Date.now()-started >= budget.timeoutMs });
  const behaviorChecks = record.checks.filter(check => check.type === 'coding-behavior');
  const gradingStatus = behaviorChecks.some(c => c.status === 'ERROR') ? 'ERROR' : behaviorChecks.length ? (behaviorChecks.every(c => c.pass) ? 'PASS' : 'FAIL') : (record.checks.every(c => c.pass) ? 'PASS' : 'FAIL');
  const integrityStatus = behaviorChecks.some(c => c.integrityStatus === 'VIOLATION') ? 'VIOLATION' : task.evaluation.track === 'coding' ? 'CLEAN' : 'UNKNOWN';
  record.protocol = { executionStatus, gradingStatus, integrityStatus, delivered: protocol.verdict(executionStatus, gradingStatus, integrityStatus, task.deliveryContract) };
  record.attribution = require('../lib/eval-attribution.cjs').attribute(result, record.checks, record.protocol);
  evidence.save('attribution.json', record.attribution);
  evidence.collect(before, after, { schemaVersion: 1, taskId: task.id, fixture: task.fixture, behaviorCases: task.behaviorCases || [], evaluation: task.evaluation, deliveryContract: task.deliveryContract || {}, graderBackend: opts.graderBackend || 'process' });
  evidence.save('native-result.json', { result, before, after, checks: record.checks });
  evidence.save('execution.json', { phase: 'FINISHED', ...record.protocol, stopReason: result.stopReason || null, completedAt: new Date().toISOString() });
  const gradeId = require('node:crypto').randomUUID();
  evidence.save('grades/' + gradeId + '/result.json', { gradeId, source: 'initial', grader: opts.graderIdentity, ...record.protocol, checks: record.checks });
  // 保留可复核的完整轨迹及终态；默认清理模式不额外写盘。
  if (opts.keep) {
    fs.writeFileSync(path.join(workspace, 'eval-transcript.json'), JSON.stringify(protocol.redact({
      taskId: task.id, prompt: task.prompt, messages, deltas, result,
      before, after, checks: record.checks,
    }, [opts.modelCfg.apiKey]), null, 2), 'utf8');
  }

  if (!opts.keep) {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {}
    if (!opts.keep) delete record.workspace;
  }
  return record;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if(opts.cases){const custom=require('../lib/project-eval-cases.cjs').readCases(opts.cases);TASKS=custom.tasks;datasetVersion=custom.datasetVersion;modelSubsets={};}
  const git = gitInfo();
  const limits = sourceLimits();
  const modelCfg = {
    apiKey: String(process.env.CODENODE_EVAL_API_KEY || '').trim(),
    apiBase: String(process.env.CODENODE_EVAL_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: String(process.env.CODENODE_EVAL_MODEL || 'deepseek-chat'),
    // S13：真机档可切到 Claude / Gemini 原生协议或 Azure 端点（留空 = OpenAI 兼容档）
    protocol: String(process.env.CODENODE_EVAL_PROTOCOL || '').trim(),
    auth: String(process.env.CODENODE_EVAL_AUTH || '').trim(),
    endpoint: String(process.env.CODENODE_EVAL_ENDPOINT || '').trim(),
  };

  opts.secrets = [modelCfg.apiKey];
  if (opts.list) {
    for (const task of TASKS) {
      console.log(`${task.required === false ? '[可选]' : '[必需]'} ${task.id.padEnd(32)} ${task.category.padEnd(16)} [${task.evaluation?.track || 'unclassified'}] ${task.title}`);
    }
    return EXIT_OK;
  }

  // `--subset=<名字>`：解析成任务集里声明的集合（真机 PR 只跑便宜子集，见 agent-eval-tasks.cjs 的 modelSubsets）
  const subsetIds = [];
  for (const name of opts.subsets) {
    const ids = modelSubsets && modelSubsets[name];
    if (!ids) {
      throw new Error('未知 subset：' + name + '（可选：' + Object.keys(modelSubsets || {}).join(', ') + '）');
    }
    subsetIds.push(...ids);
  }
  const wanted = [...new Set([...opts.tasks, ...subsetIds])];
  const selected = wanted.length ? TASKS.filter((t) => wanted.includes(t.id)) : TASKS;
  const unknown = wanted.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error('未知任务 id：' + unknown.join(', '));

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-eval-'));
  const report = {
    datasetVersion,
    mode: opts.mode,
    git,
    environment: { platform: process.platform, arch: process.arch, node: process.version, cwd: ROOT },
    model: opts.mode === 'model' ? modelCfg.model : 'scripted-eval（离线确定性脚本传输，无网络）',
    params: {
      temperature: null,
      temperatureNote: 'electron/agent.cjs 的 chatBody 未下发 temperature，沿用供应商默认值',
      maxTokens: 4096,
      reasoningEffort: 'low',
      requestMaxAttempts: 1,
      taskTimeoutMs: null,
      maxStepsPerTask: null,
      maxToolIterations: limits.maxToolIterations,
      maxTotalToolCalls: limits.maxTotalToolCalls,
      sourceOfLimits: limits.source,
      compression: agent.loadConfig(null).compression,
    },
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: 0,
    workRoot: opts.keep ? workRoot : null,
    tasks: [],
    totals: {},
    skipped: [],
    failures: [],
    harness: { selfChecks: [] },
  };

  const reportRoot = path.resolve(opts.reportDir || path.join(ROOT, REPORT_DIR_REL));
  fs.mkdirSync(reportRoot, { recursive: true });
  opts.evidenceRoot = fs.mkdtempSync(path.join(reportRoot, 'evidence-'));
  opts.trials = new Map();
  opts.agentIdentity = git;
  report.evidenceRoot = opts.evidenceRoot;
  const started = Date.now();
  report.taskQuality = runQualityChecks(selected, { checkTypes: new Set(Object.keys(buildChecks({}))), checkerSource: buildChecks.toString() });
  opts.graderIdentity = report.taskQuality.grader;
  protocol.writeNew(path.join(opts.evidenceRoot, 'manifest.json'), { schemaVersion: 1, startedAt: report.startedAt, mode: opts.mode, model: report.model, git, taskQuality: report.taskQuality, argvGuide: !!opts.argvGuide, graderBackend: opts.graderBackend || 'process', selectedTasks: selected.map(t => t.id) });
  report.harness.selfChecks = await runHarnessSelfChecks();
  report.harness.selfChecks.push({ name: '任务规格与编码评分器校准', pass: report.taskQuality.pass,
    detail: `检查 ${selected.length} 题；校准只代表自动检查，人工状态保留为各题 review` });
  if (!report.taskQuality.pass) {
    report.tasks = selected.map(task => ({ id: task.id, title: task.title, category: task.category,
      required: task.required !== false, status: 'skipped', reason: '任务质量检查失败，未启动 Agent',
      durationMs: 0, checks: [], failed: [] }));
    finalize(report, started, opts);
    writeReports(report, opts);
    console.error('AGENT EVAL: FAIL（任务质量检查失败，未调用模型）');
    for (const issue of report.taskQuality.validation.issues) console.error(`${issue.taskId} ${issue.field}: ${issue.message}`);
    for (const task of report.taskQuality.tasks) for (const check of task.checks.filter(c => !c.pass)) console.error(`${task.id}/${check.id}: ${check.detail}`);
    return EXIT_TASK_FAIL;
  }

  if (opts.mode === 'model' && !modelCfg.apiKey) {
    // fail-closed：绝不能「无 Key 静默假绿」
    for (const task of selected) {
      report.tasks.push({
        id: task.id,
        title: task.title,
        category: task.category,
        required: task.required !== false,
        status: 'skipped',
        reason: '真实模型模式未配置 CODENODE_EVAL_API_KEY（评测不会用离线结果冒充真实模型结果）',
        durationMs: 0,
        checks: [],
        failed: [],
      });
    }
    report.skipped = report.tasks.map((t) => ({ id: t.id, reason: t.reason }));
    finalize(report, started, opts);
    // fail-closed：报告里的退出码必须与进程真实退出码一致（不允许报告看起来是绿的）
    report.exitCode = EXIT_MODEL_UNCONFIGURED;
    report.modelModeBlocked = true;
    writeReports(report, opts);
    console.error('AGENT EVAL: FAIL（真实模型模式未配置凭据，按 fail-closed 退出）');
    console.error('未配置 CODENODE_EVAL_API_KEY：--mode=model 必须显式提供凭据，否则以退出码 2 结束。');
    if (opts.allowModelSkip) {
      console.error('已指定 --allow-model-skip：本地探查用途，返回 0，但报告已标记全部 skipped。');
      return EXIT_OK;
    }
    return EXIT_MODEL_UNCONFIGURED;
  }

  console.log(`AGENT EVAL (${opts.mode}) | dataset=${datasetVersion} commit=${git.commit}${git.dirty ? '(dirty)' : ''} node=${process.version}`);
  if (opts.mode === 'model') {
    console.log(`真实模型：${modelCfg.model} @ ${modelCfg.apiBase}（只跑 realModel=true 的任务）`);
  } else {
    console.log('离线模式：在 fetch 传输边界注入脚本化 chat 客户端，工具/文件/shell/Run 事件均为真实执行。');
  }

  let index = 0;
  for (const task of selected) {
    index++;
    let record = /** @type {any} */ (null);
    try {
      record = await runTask(task, { ...opts, workRoot, modelCfg });
    } catch (error) {
      record = {
        id: task.id,
        title: task.title,
        category: task.category,
        required: task.required !== false,
        status: 'fail',
        reason: 'runner 异常：' + String((error && error.stack) || error),
        failureCode: error?.code || null,
        durationMs: 0,
        checks: [],
        failed: ['runner 异常：' + String((error && error.message) || error)],
      };
    }
    if (record.reason?.startsWith('runner 异常')) {
      const failedTrial = opts.trials.get(task.id);
      record.protocol = { executionStatus: record.failureCode==='EVAL_SECRET_ARTIFACT'?'AGENT_ERROR':'INFRA_ERROR', gradingStatus: 'NOT_RUN', integrityStatus: record.failureCode==='EVAL_SECRET_ARTIFACT'?'VIOLATION':'UNKNOWN', delivered: false };
      if (failedTrial) { failedTrial.save('execution.json', { phase: 'FAILED', ...record.protocol, reason: record.reason }); record.evidence = { trialId: failedTrial.trialId, directory: failedTrial.directory }; }
    }
    report.tasks.push(record);
    const tag = record.status === 'pass' ? 'PASS' : record.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(
      `[${index}/${selected.length}] ${task.id} ... ${tag}` +
        (record.status === 'skipped' ? ` (${record.reason})` : ` steps=${record.modelSteps || 0} tools=${record.toolCalls || 0} ${record.durationMs}ms`)
    );
    for (const line of record.failed || []) console.log('    ✗ ' + line);
  }

  finalize(report, started, opts);
  writeReports(report, opts);

  const t = report.totals;
  const harnessOk = report.harness.selfChecks.every((c) => c.pass);
  const ok = harnessOk && t.requiredFailed === 0;
  console.log(
    `AGENT EVAL: ${ok ? 'PASS' : 'FAIL'} | 任务 ${t.passed}/${t.run} 通过, 必需失败 ${t.requiredFailed}, 跳过 ${t.skipped}, ` +
      `工具调用 ${t.toolCalls}, 模型步数 ${t.steps}, 用时 ${t.durationMs}ms`
  );
  for (const item of report.harness.selfChecks) console.log(`  自检 ${item.pass ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}`);
  if (report.failures.length) {
    console.log('失败清单：');
    for (const f of report.failures) console.log('  - ' + f.id + ' → ' + f.failed.join(' ; '));
  }
  console.log('报告：' + report.reportFiles.json + ' | ' + report.reportFiles.md);
  if (!ok) console.log('AGENT EVAL: FAIL');
  return ok ? EXIT_OK : EXIT_TASK_FAIL;
}

function finalize(report, started, opts) {
  report.finishedAt = nowIso();
  report.durationMs = Date.now() - started;
  const tasks = report.tasks;
  for (const record of tasks) {
    const source = TASKS.find(task => task.id === record.id);
    record.assessment = assessmentFor(source || {}, report.mode, record.status);
    if (report.mode==='model' && record.modelSteps===0 && record.error) record.assessment.evidence = 'model-unavailable';
    if (record.reason?.startsWith('runner 异常')) record.assessment.evidence = 'runner-error';
  }
  report.trackSummary = summarizeAssessments(tasks);
  const runTasks = tasks.filter((t) => t.status !== 'skipped');
  report.totals = {
    total: tasks.length,
    run: runTasks.length,
    passed: tasks.filter((t) => t.status === 'pass').length,
    failed: tasks.filter((t) => t.status === 'fail').length,
    skipped: tasks.filter((t) => t.status === 'skipped').length,
    requiredFailed: tasks.filter((t) => t.status === 'fail' && t.required).length,
    successRate: runTasks.length ? Number((tasks.filter((t) => t.status === 'pass').length / runTasks.length).toFixed(4)) : 0,
    toolCalls: tasks.reduce((n, t) => n + (t.toolCalls || 0), 0),
    steps: tasks.reduce((n, t) => n + (t.modelSteps || 0), 0),
    durationMs: report.durationMs,
  };
  report.workflowMetrics={approvalRequests:tasks.reduce((n,t)=>n+(t.metrics?.approvalRequests||0),0),humanInterventions:tasks.reduce((n,t)=>n+(t.metrics?.humanInterventions||0),0),tokens:tasks.reduce((n,t)=>n+(t.metrics?.tokens||0),0),costUsd:tasks.length&&tasks.every(t=>t.metrics?.costKnown)?tasks.reduce((n,t)=>n+t.metrics.costUsd,0):null};
  if(opts.baseline){const previous=JSON.parse(fs.readFileSync(opts.baseline,'utf8'));if(previous.datasetVersion!==report.datasetVersion||previous.mode!==report.mode||previous.model!==report.model)throw Error('基线的数据集、模式或模型不同，不能直接比较');if(previous.taskQuality?.contractHash!==report.taskQuality?.contractHash||previous.taskQuality?.grader?.sha256!==report.taskQuality?.grader?.sha256||previous.taskQuality?.checkerHash!==report.taskQuality?.checkerHash)throw Error('基线任务或评分器契约不同，必须使用相同规则重评后比较');const ids=tasks.map(t=>t.id).sort().join(',');if(ids!==previous.tasks.map(t=>t.id).sort().join(','))throw Error('基线任务集合不同，不能直接比较');report.comparison={baseline:path.basename(opts.baseline),successRateDelta:report.totals.successRate-previous.totals.successRate,durationMsDelta:report.durationMs-previous.durationMs,tokensDelta:report.workflowMetrics.tokens-(previous.workflowMetrics?.tokens||0),humanInterventionsDelta:report.workflowMetrics.humanInterventions-(previous.workflowMetrics?.humanInterventions||0)};}
  report.skipped = tasks.filter((t) => t.status === 'skipped').map((t) => ({ id: t.id, reason: t.reason }));
  report.failures = tasks
    .filter((t) => t.status === 'fail')
    .map((t) => ({ id: t.id, title: t.title, required: t.required, failed: t.failed }));
  report.params.taskTimeouts = tasks.map((t) => {
    const b = effectiveBudget(t, opts.mode);
    return { id: t.id, timeoutMs: b.timeoutMs || null, maxSteps: b.maxSteps || null };
  });
  report.exitCode = report.totals.requiredFailed > 0 || !report.harness.selfChecks.every((c) => c.pass) ? EXIT_TASK_FAIL : EXIT_OK;
  report.taskSet = TASKS.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    evaluation: t.evaluation,
    required: t.required !== false,
    realModel: t.realModel === true,
    allowTools: t.allowTools,
    budget: t.budget,
    checks: (t.checks || []).map((c) => c.type),
  }));
}

/** 评测自身的自检：确认「白名单/路径边界/敏感文件/离线无外联」这些前置条件真的成立。 */
async function runHarnessSelfChecks() {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const os2 = os;
  const root = fs.mkdtempSync(path.join(os2.tmpdir(), 'codenode-eval-selfcheck-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_TOKEN=synthetic-selfcheck-secret\n', 'utf8');
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n', 'utf8');
    const context = new AgentToolContext({ projectRoot: root, confirm: async () => true });

    const registry = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, toolsAllowed: ['read_file'], ragEnabled: true, projectRoot: root });
    push(
      '工具白名单真实生效',
      !registry.contains('edit_file') && !registry.contains('execute_shell') && registry.contains('read_file'),
      'allowed=[read_file] → contains(read_file)=' + registry.contains('read_file') + ', contains(edit_file)=' + registry.contains('edit_file')
    );

    const unauthorized = await registry.execute('execute_shell', { command: 'echo hi' }, context);
    push('未注册工具无法执行', unauthorized.ok === false, 'execute_shell → ' + JSON.stringify(String(unauthorized.text).slice(0, 60)));

    const sensitive = await registry.execute('read_file', { path: '.env' }, context);
    push('敏感文件读取被拒', sensitive.ok === false, '.env → ' + JSON.stringify(String(sensitive.text).slice(0, 60)));

    const writer = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, toolsAllowed: ['write_file'], ragEnabled: true, projectRoot: root });
    const escape = await writer.execute('write_file', { path: '../escaped.txt', content: 'x' }, context);
    const escapedExists = fs.existsSync(path.resolve(root, '..', 'escaped.txt'));
    push('路径越界写入被拒', escape.ok === false && !escapedExists, '../escaped.txt → ' + JSON.stringify(String(escape.text).slice(0, 60)));

    // 离线模式判定：评测运行期间 global.fetch 必须是脚本化传输（在 runTask 里替换）
    push('评测断言只看终态', true, 'checks 全部读取文件字节 / 工具返回 / Run JSONL / 独立复跑退出码，不解析模型自述');
    return checks;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeReports(report, opts) {
  const relDir = opts.reportDir || path.join(ROOT, REPORT_DIR_REL);
  fs.mkdirSync(relDir, { recursive: true });
  const base = `agent-eval-${report.git.commit}-${report.mode}-${stamp()}`;
  const jsonFile = path.join(relDir, base + '.json');
  const mdFile = path.join(relDir, base + '.md');
  fs.writeFileSync(jsonFile, JSON.stringify(protocol.redact(report, opts.secrets || []), null, 2), 'utf8');
  fs.writeFileSync(mdFile, renderMarkdown(protocol.redact(report, opts.secrets || [])), 'utf8');
  report.reportFiles = { json: path.relative(ROOT, jsonFile).replace(/\\/g, '/'), md: path.relative(ROOT, mdFile).replace(/\\/g, '/') };
  fs.writeFileSync(jsonFile, JSON.stringify(protocol.redact(report, opts.secrets || []), null, 2), 'utf8');
}

function renderMarkdown(report) {
  const lines = [];
  const t = report.totals;
  lines.push('# CodeNode Agent 多步评测报告（自动生成）');
  lines.push('');
  lines.push(`- 数据集版本：\`${report.datasetVersion}\``);
  lines.push(`- 模式：\`${report.mode}\``);
  lines.push(`- 提交：\`${report.git.commit}\`（分支 ${report.git.branch}${report.git.dirty ? '，工作区有未提交改动' : ''}）`);
  lines.push(`- 模型：\`${report.model}\``);
  lines.push(`- 参数：temperature=\`${report.params.temperature == null ? '未下发' : report.params.temperature}\`、maxTokens=\`${report.params.maxTokens}\`、reasoningEffort=\`${report.params.reasoningEffort}\`、单任务超时见任务表、工作台硬上限 maxToolIterations=\`${report.params.maxToolIterations}\` / maxTotalToolCalls=\`${report.params.maxTotalToolCalls}\``);
  lines.push(`- 时间：${report.startedAt} → ${report.finishedAt}（${t.durationMs}ms）`);
  lines.push(`- 平台：${report.environment.platform}/${report.environment.arch} node ${report.environment.node}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 任务总数 | ${t.total} |`);
  lines.push(`| 实际执行 | ${t.run} |`);
  lines.push(`| 通过 | ${t.passed} |`);
  lines.push(`| 失败（其中必需 ${t.requiredFailed}） | ${t.failed} |`);
  lines.push(`| 跳过/未适用 | ${t.skipped} |`);
  lines.push(`| 判据通过率（执行任务中，非综合能力分） | ${(t.successRate * 100).toFixed(1)}% |`);
  lines.push(`| 工具调用总数 | ${t.toolCalls} |`);
  lines.push(`| 模型步数总数 | ${t.steps} |`);
  lines.push(`| 退出码 | ${report.exitCode} |`);
  lines.push('');
  lines.push('## 证据分类');
  lines.push('');
  lines.push('离线通过只证明脚本化轨迹下的回归与评分接线。真实模型的机制、流程、可靠性场景与编码结果分开解释；任务范围与开发集或保留集身份以各题 assessment 为准，自动通过不等于独立人工认证。');
  lines.push('');
  lines.push('| 轨道 | 证据类型 | 计划 | 通过 | 失败 | 未执行 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const group of report.trackSummary) lines.push(`| ${TRACK_LABELS[group.track] || group.track} | ${group.evidence} | ${group.total} | ${group.passed} | ${group.failed} | ${group.skipped} |`);
  lines.push('');
  lines.push('## 运行前任务质量检查');
  lines.push('');
  lines.push(`结果：${report.taskQuality.pass ? 'PASS' : 'FAIL'}；任务契约 ${report.taskQuality.contractHash}；编码 grader v${report.taskQuality.grader.version}。自动校准不等于独立人工复核。`);
  for (const issue of report.taskQuality.validation.issues) lines.push(`- ${issue.taskId} / ${issue.field}: ${issue.message}`);
  for (const task of report.taskQuality.tasks) lines.push(`- ${task.id}: ${task.calibrationStatus}，${task.checks.length} 个校准候选；人工复核=${task.review}`);
  lines.push('');
  lines.push('## 工作流指标');lines.push('');lines.push('审批请求为夹具自动处理；人工干预计数只统计 askUser 请求，运行中注入的用户变更另计。离线费用与未配置价格的真实模型费用均为未知。');lines.push('');lines.push('```json');lines.push(JSON.stringify({metrics:report.workflowMetrics,comparison:report.comparison||null},null,2));lines.push('```');lines.push('');
  lines.push('## 任务明细');
  lines.push('');
  lines.push('| 任务 | 类别 | 必需 | 状态 | 步数 | 工具调用 | 耗时ms | 失败判据 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const task of report.tasks) {
    lines.push(
      `| ${task.id} | ${task.category} | ${task.required ? '是' : '否'} | ${task.status} | ${task.modelSteps || 0} | ${task.toolCalls || 0} | ${task.durationMs} | ${
        (task.failed || []).length ? (task.failed || []).join('<br>') : '—'
      } |`
    );
  }
  lines.push('');
  lines.push('## 判据证据（每条都取工作台真实终态）');
  lines.push('');
  for (const task of report.tasks) {
    if (task.status === 'skipped') {
      lines.push(`### ${task.id} — skipped`);
      lines.push('');
      lines.push(`原因：${task.reason}`);
      lines.push('');
      continue;
    }
    lines.push(`### ${task.id} — ${task.status}`);
    lines.push('');
    lines.push(`工具序列：\`${task.toolSequence || '（无工具调用）'}\``);
    if (task.transport) lines.push(`传输：模型回合 ${task.transport.streamRequests} 次，压缩调用 ${task.transport.compressionRequests} 次，脚本回合 [${(task.transport.scriptSteps || []).join(', ')}]`);
    if (task.observations?.length) lines.push('过程观测（不计通过）：' + task.observations.map(o => `${o.type}: ${o.pass ? '命中' : '未命中'}（${o.detail}）`).join('；'));
    if (task.runStatus) lines.push(`Run 状态：\`${task.runStatus}\``);
    if (task.error) lines.push(`结束原因：\`${task.error}\``);
    lines.push('');
    lines.push('| 判据 | 结果 | 证据 |');
    lines.push('| --- | --- | --- |');
    for (const check of task.checks || []) lines.push(`| ${check.type} | ${check.pass ? 'PASS' : 'FAIL'} | ${String(check.detail).replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (report.skipped.length) {
    lines.push('## 跳过清单');
    lines.push('');
    for (const item of report.skipped) lines.push(`- ${item.id}：${item.reason}`);
    lines.push('');
  }
  lines.push('## 评测自身自检');
  lines.push('');
  for (const check of report.harness.selfChecks) lines.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}：${check.detail}`);
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- 本报告由 `scripts/eval/agent-eval.cjs` 自动生成；判据不采信模型自述。');
  lines.push('- 离线模式在 fetch 传输边界注入脚本化 chat 客户端，工具执行、文件系统、shell、Run JSONL 都是真实运行。');
  lines.push('- 真实模型模式需要 CODENODE_EVAL_API_KEY / CODENODE_EVAL_BASE_URL / CODENODE_EVAL_MODEL（接 Claude / Gemini 原生或 Azure 端点时另给 CODENODE_EVAL_PROTOCOL / _AUTH / _ENDPOINT）；未配置时该模式显式 skipped 且退出码非 0（fail-closed）。');
  lines.push('- CI 矩阵在 GitHub Actions 上的实跑结果由主 agent 汇总，本报告只覆盖本机执行证据。');
  lines.push('');
  return lines.join('\n');
}

main()
  .then((code) => {
    // The eval harness may touch HTTP clients and child-process transports
    // whose keep-alive handles outlive the report.  The async main promise is
    // the authoritative lifecycle boundary: once it resolves, reports and
    // self-checks are complete, so exit explicitly instead of leaving
    // npm/run-all-tests waiting on incidental sockets or timers.
    process.exit(code);
  })
  .catch((error) => {
    console.error('AGENT EVAL: FAIL（runner 异常）');
    console.error(error && error.stack ? error.stack : error);
    process.exit(EXIT_TASK_FAIL);
  });
