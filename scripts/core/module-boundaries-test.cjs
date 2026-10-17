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
assert.ok(lines('electron/agent.cjs') <= 4450, 'electron/agent.cjs grew beyond the current migration ceiling');
assert.ok(lines('electron/agentRuntimeConfig.cjs') <= 120, 'agent runtime config module lost its focused boundary');
assert.ok(lines('electron/ipc/agent.cjs') <= 1880, 'electron/ipc/agent.cjs grew beyond the current migration ceiling');
assert.ok(lines('electron/ipc/backend.cjs') <= 80, 'backend IPC module lost its focused boundary');
assert.ok(lines('src/styles.css') <= 4540, 'src/styles.css grew beyond the current migration ceiling');
assert.ok(lines('src/components/ProjectGate.css') <= 620, 'ProjectGate styles lost their component boundary');
assert.match(read('src/components/ProjectGate.tsx'), /import '\.\/ProjectGate\.css'/, 'ProjectGate must own its styles');
assert.doesNotMatch(read('src/styles.css'), /启动门禁页/, 'global styles must not absorb ProjectGate styles again');

console.log('MODULE BOUNDARIES: PASS (editor/dock separation and non-increasing legacy size ceilings)');
