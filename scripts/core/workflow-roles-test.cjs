'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const gate = fs.readFileSync(path.join(root, '.github/workflows/production-gate.yml'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

assert.match(ci, /push:\s*\n\s*branches: \[yimi-branch\]/, 'delivery CI must run on yimi-branch pushes');
assert.match(ci, /pull_request:\s*\n\s*branches: \[main\]/, 'delivery CI must validate PRs entering main');
assert.doesNotMatch(ci, /push:\s*\n\s*branches: \[main\]/, 'main pushes must not duplicate delivery CI');
assert.match(gate, /push:\s*\n\s*branches: \[main\]/, 'production gate must run after main advances');
assert.match(gate, /if: github\.event_name != 'pull_request'/, 'PRs must not repeat the offline production gate');
assert.match(gate, /model-eval-pr:/, 'PR workflow must retain the optional real-model subset');
assert.match(release, /tags:\s*\n\s*- 'v\*'/, 'version tags must use the dedicated release workflow');

console.log('WORKFLOW ROLES: PASS (yimi delivery CI, main production gate, PR dedupe, tag release)');
