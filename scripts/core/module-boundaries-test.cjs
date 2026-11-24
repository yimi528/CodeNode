'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const lines = file => read(file).split(/\r?\n/).length;

const fileWorkspace = read('src/components/FileWorkspace.tsx');
const dock = read('src/components/WorkbenchDock.tsx');
assert.match(fileWorkspace, /import EditorPanel from '\.\/EditorPanel'/, 'file workspace must own the editor dependency directly');
assert.doesNotMatch(fileWorkspace, /WorkbenchDock/, 'file workspace must not pull the complete dock module into its chunk');
assert.doesNotMatch(dock, /function EditorPanel|highlightCode|diagnoseCode/, 'dock must not absorb the file editor implementation again');
assert.ok(lines('src/components/WorkbenchDock.tsx') <= 750, 'WorkbenchDock exceeded its post-split 750-line budget');
assert.ok(lines('src/components/EditorPanel.tsx') <= 180, 'EditorPanel exceeded its focused 180-line budget');

// Existing large legacy modules remain tracked explicitly: this prevents silent growth while later splits
// reduce the ceilings instead of accepting a new, larger baseline.
assert.ok(lines('electron/agent.cjs') <= 3240, 'electron/agent.cjs grew beyond the current migration ceiling');
assert.ok(lines('electron/agentRuntimeConfig.cjs') <= 120, 'agent runtime config module lost its focused boundary');
assert.ok(lines('electron/agentContextConfig.cjs') <= 120, 'context configuration must remain a focused module');
assert.ok(lines('electron/agentGrounding.cjs') <= 190, 'agent grounding module lost its focused boundary');
assert.ok(lines('electron/agentCompression.cjs') <= 400, 'agent compression module lost its focused boundary');
assert.ok(lines('electron/ipc/agent.cjs') <= 1880, 'electron/ipc/agent.cjs grew beyond the current migration ceiling');
assert.ok(lines('electron/ipc/backend.cjs') <= 80, 'backend IPC module lost its focused boundary');
const desktopStyles = read('src/styles.css');
assert.ok(lines('src/styles.css') <= 20, 'desktop stylesheet must remain an ordered entry point');
/** @type {Array<[string, number]>} */
const stylesheetSections = [
  ['base', 1100], ['inspector', 260], ['workbench-frame', 520], ['workbench-dock', 330], ['workbench', 1300],
  ['components/ProjectGate', 620], ['components/ErrorBoundary', 120], ['components/RunReplayPanel', 120],
  ['components/ToolDialog', 240], ['components/ModelManager', 240], ['components/side/SidePanel', 1050],
];
for (const [file, limit] of stylesheetSections) {
  assert.ok(desktopStyles.includes("@import './" + file + ".css';"), file + ' must be loaded by the desktop stylesheet');
  assert.ok(lines('src/' + file + '.css') <= limit, file + ' styles exceeded their module boundary');
}
assert.doesNotMatch(desktopStyles, /启动门禁页|渲染崩溃兜底页|运行回放（S8）|Agent 工具请求弹窗|模型管理对话框|左侧统一侧栏/,
  'desktop entry point must not absorb component styles');

const knownIssues = read('docs/known-issues.md');
for (const id of ['WIN-SANDBOX', 'RELEASE-SIGNING', 'BACKEND-MATRIX', 'MODULE-SPLIT', 'MAC-PIXEL-QA']) {
  assert.match(knownIssues, new RegExp(`\\| ${id} \\|`), `known issue ${id} must remain tracked until completed`);
}
for (const template of ['bug.yml', 'engineering-debt.yml']) {
  const source = read(`.github/ISSUE_TEMPLATE/${template}`);
  assert.match(source, /validations:\s*\n\s*required: true/, `${template} must require evidence-bearing fields`);
}

console.log('MODULE BOUNDARIES: PASS (editor/dock separation and non-increasing legacy size ceilings)');

assert.ok(lines('electron/agentPrompt.cjs') <= 580, 'prompt construction exceeded its module boundary');
assert.ok(lines('electron/agentOverflow.cjs') <= 130, 'overflow observations exceeded their module boundary');
assert.doesNotMatch(read('electron/agent.cjs'), /function buildSystemPrompt|function noteContextOverflow/, 'prompt and overflow domains must remain outside the execution loop');
