#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'docs', 'development-log');
const TYPES = new Set(['fix', 'feature', 'refactor', 'docs', 'chore']);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const [rawName, inlineValue] = argument.slice(2).split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && nextValue && !nextValue.startsWith('--')) index += 1;
    values[rawName] = nextValue || '';
  }
  return values;
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const day = `${value('year')}-${value('month')}-${value('day')}`;
  const time = `${value('hour')}:${value('minute')}:${value('second')}`;
  return { day, timestamp: `${day} ${time} CST` };
}

function line(value, fallback = '无') {
  const normalized = String(value || '').trim();
  return `- ${normalized || fallback}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const type = args.type || 'chore';
  if (!TYPES.has(type)) {
    throw new Error(`--type 必须是 ${Array.from(TYPES).join(', ')} 之一`);
  }
  if (!String(args.summary || '').trim()) {
    throw new Error('缺少 --summary；请用一句话说明本次开发结果');
  }

  const { day, timestamp } = shanghaiParts();
  const file = path.join(LOG_DIR, `${day}.md`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${day} 开发日志\n`, 'utf8');

  const isFix = type === 'fix';
  const entry = [
    '',
    `## ${timestamp}`,
    '',
    '### 修复的 Bug',
    '',
    line(isFix ? args.summary : ''),
    '',
    '### 更新内容',
    '',
    line(args.details || (!isFix ? args.summary : '')),
    '',
    '### 验证结果',
    '',
    line(args.verification, '待验证'),
    '',
  ].join('\n');
  fs.appendFileSync(file, entry, 'utf8');
  console.log(path.relative(ROOT, file));
}

try {
  main();
} catch (error) {
  console.error(`开发日志创建失败：${error.message}`);
  process.exitCode = 1;
}
