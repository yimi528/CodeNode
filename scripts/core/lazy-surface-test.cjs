'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

for (const component of ['GlobalSettings', 'ModelManager', 'WorkbenchDock', 'PluginWorkspace', 'TaskWorkspace', 'FileWorkspace', 'Canvas', 'GoalOverview', 'Toolbar']) {
  assert.match(app, new RegExp(`const ${component} = lazy\\(\\(\\) => import\\('\\./components/${component}'\\)\\)`), `${component} must be code-split`);
  assert.doesNotMatch(app, new RegExp(`import ${component} from`), `${component} must not remain in the initial module graph`);
}
assert.match(app, /settingsOpen \? <GlobalSettings \/>/, 'settings chunk must mount only while open');
assert.match(app, /modelManagerOpen \? <ModelManager \/>/, 'model manager chunk must mount only while open');
assert.match(app, /dockOpen && appPage === 'workbench' \? <WorkbenchDock \/>/, 'dock chunk must mount only while visible');
assert.match(app, /appPage === 'plugins' \? <PluginWorkspace \/>/, 'plugin workspace must load only on its page');
assert.match(app, /appPage === 'tasks' \? <TaskWorkspace hidden=\{false\} \/>/, 'task workspace must load only on its page');
assert.match(app, /sideTab === 'project' \|\| sideTab === 'preview'\) \? <FileWorkspace \/>/, 'file workspace must load only on file tabs');
assert.match(app, /<Suspense fallback=\{null\}>/, 'lazy surfaces need a non-disruptive suspense boundary');

console.log('LAZY SURFACES: PASS (settings, model manager and dock excluded from initial module graph)');
