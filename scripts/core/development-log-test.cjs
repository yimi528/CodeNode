#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'docs', 'development-log');
const LOG_PATH = 'docs/development-log/';
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
const TIMESTAMP = /^## (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2} CST$/gm;
const REQUIRED_SECTIONS = ['### 修复的 Bug', '### 更新内容', '### 验证结果'];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function changedPaths() {
  if (process.env.CI === 'true') {
    try {
      let base = '';
      if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
        const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
        base = event.pull_request?.base?.sha || event.before || '';
      }
      if (/^0+$/.test(base)) return git(['ls-tree', '-r', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean);
      return git(['diff', '--name-only', base || 'HEAD^', 'HEAD']).split(/\r?\n/).filter(Boolean);
    } catch (error) {
      throw new Error('CI 无法读取 push / PR 的比较范围，开发日志门禁不能安全判断；请使用完整 checkout 历史', { cause: error });
    }
  }
  try {
    // Local ownership is defined by the staged payload, not every dirty file in the shared
    // worktree. This prevents a completed/committed log entry from claiming unrelated user edits.
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMRDTUXB']).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function shanghaiDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

assert.ok(fs.existsSync(LOG_DIR) && fs.statSync(LOG_DIR).isDirectory(), '缺少 docs/development-log 日志目录');
const readme = path.join(LOG_DIR, 'README.md');
assert.ok(fs.existsSync(readme) && fs.statSync(readme).isFile(), '缺少开发日志使用说明');

const files = fs.readdirSync(LOG_DIR).filter((name) => name !== 'README.md');
assert.ok(files.length > 0, '开发日志目录中至少需要一个日期文件');

for (const file of files) {
  assert.match(file, DAY_FILE, `日志文件名必须使用 YYYY-MM-DD.md：${file}`);
  const day = file.slice(0, 10);
  const content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
  assert.ok(content.startsWith(`# ${day} 开发日志\n`), `${file} 缺少正确的日期标题`);
  const entries = [...content.matchAll(TIMESTAMP)];
  assert.ok(entries.length > 0, `${file} 至少需要一条精确到秒的 CST 记录`);
  for (const entry of entries) assert.equal(entry[1], day, `${file} 的条目日期必须与文件名一致`);
  for (const section of REQUIRED_SECTIONS) {
    assert.equal((content.match(new RegExp(section, 'g')) || []).length, entries.length, `${file} 的每条记录都必须包含“${section}”`);
  }
}

const changed = changedPaths();
const developmentChanges = changed.filter((name) => name && !name.startsWith(LOG_PATH));
if (developmentChanges.length > 0) {
  const changedLogs = new Set(changed.filter((name) => name.startsWith(LOG_PATH)));
  if (process.env.CI === 'true') {
    assert.ok(changedLogs.size > 0, '当前 push / PR 包含开发改动，但没有同步更新 docs/development-log/');
  } else {
    const today = `${LOG_PATH}${shanghaiDay()}.md`;
    assert.ok(changedLogs.has(today), `暂存区包含开发改动，但今天的日志未同步暂存：${today}`);
  }
}

console.log('DEVELOPMENT LOG: PASS (dated files, second-level CST timestamps, required sections, change linkage)');
