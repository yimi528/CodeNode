#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

function validateTag(tag, version = pkg.version) {
  const normalized = String(tag || '').trim();
  const expected = `v${version}`;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) throw new Error(`发布标签格式无效：${normalized || '(empty)'}`);
  if (normalized !== expected) throw new Error(`发布标签 ${normalized} 与 package.json 版本 ${version} 不一致；期望 ${expected}`);
  return normalized;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main(argv = process.argv.slice(2)) {
  const tag = validateTag(argv[0] || process.env.RELEASE_TAG);
  const head = git(['rev-parse', 'HEAD']);
  const tagged = git(['rev-parse', `refs/tags/${tag}^{commit}`]);
  if (head !== tagged) throw new Error(`当前提交 ${head.slice(0, 12)} 不是标签 ${tag} 指向的提交 ${tagged.slice(0, 12)}`);
  try { execFileSync('git', ['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main'], { cwd: ROOT, stdio: 'ignore' }); }
  catch { throw new Error(`标签 ${tag} 的提交不属于 origin/main；拒绝从未集成分支发布`); }
  console.log(`RELEASE TAG: PASS (${tag}, ${head.slice(0, 12)}, origin/main)`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`发布标签校验失败：${error.message}`); process.exitCode = 1; }
}

module.exports = { validateTag, main };
