'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/main.tsx'), 'utf8');
const design = fs.readFileSync(path.join(root, 'src/design-system.css'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const themes = require(path.join(root, 'config/ui.themes.json'));

assert.match(main, /import '\.\/design-system\.css';\s*\nimport '\.\/styles\.css';/, 'design primitives must load before component styles');
assert.equal((design.match(/:root\s*\{/g) || []).length, 1, 'design-system.css must have one fallback root palette');
assert.equal((styles.match(/(^|\n):root\s*\{/g) || []).length, 0, 'styles.css must not reintroduce a competing global palette');
for (const token of ['--bg', '--bg-panel', '--bg-panel-2', '--border', '--text', '--text-dim']) {
  assert.match(design, new RegExp(`${token}:`), `fallback palette missing ${token}`);
  for (const [theme, values] of Object.entries(themes)) assert.equal(typeof values[token], 'string', `${theme} missing ${token}`);
}
for (const token of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--radius-control', '--radius-card', '--radius-dialog']) {
  assert.match(design, new RegExp(`${token}:`), `design geometry missing ${token}`);
}

console.log('DESIGN SYSTEM: PASS (single fallback palette, runtime theme parity, shared spacing and radii)');
