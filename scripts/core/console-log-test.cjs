'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupConsoleLog } = require('../../electron/consoleLog.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-console-log-'));
const levels = ['log', 'info', 'warn', 'error'];
const messages = [];
const output = Object.assign(Object.create(console), Object.fromEntries(levels.map(level => [level, (...args) => messages.push([level, ...args])])));
try {
  const executable = path.join(root, 'CodeNode.app/Contents/MacOS/CodeNode');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'sealed executable fixture');
  const userDataDir = path.join(root, 'isolated-userdata');
  const file = setupConsoleLog({ platform: 'darwin', executable, userDataDir }, output);
  assert.equal(file, path.join(userDataDir, 'logs/console.log'));
  for (const level of levels) output[level]('message', { level });
  const cycle = {}; cycle.self = cycle;
  output.error(new Error('test diagnostic'), cycle);
  assert.equal(messages.length, 5, 'original console methods still receive all messages');
  const log = fs.readFileSync(file, 'utf8');
  for (const level of levels) assert.ok(log.includes(JSON.stringify({ level })));
  assert.match(log, /test diagnostic/);
  assert.match(log, /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\]/);
  assert.deepEqual(fs.readdirSync(path.dirname(executable)), ['CodeNode'], 'logging cannot add resources inside the signed app bundle');
  assert.equal(fs.readFileSync(executable, 'utf8'), 'sealed executable fixture');

  const portable = path.join(root, 'portable/CodeNode.exe');
  const portableLog = setupConsoleLog({ platform: 'win32', executable: portable, userDataDir }, Object.assign(Object.create(console), { log() {}, info() {}, warn() {}, error() {} }));
  assert.equal(portableLog, path.join(root, 'portable/logs/console.log'), 'Windows launcher keeps its existing log location');

  const blocked = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocked, 'file');
  const previous = output.log;
  assert.equal(setupConsoleLog({ platform: 'darwin', executable, userDataDir: blocked }, output), null);
  assert.equal(output.log, previous, 'unwritable logging cannot break startup or replace the console');
  fs.rmSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.dirname(file), 'file');
  assert.doesNotThrow(() => output.warn('disk no longer writable'));
  assert.equal(messages.at(-1)[1], 'disk no longer writable', 'console forwarding survives write failures');
  console.log('CONSOLE LOG: PASS (macOS bundle remains unchanged, isolated user data, Windows portable path, serialization, original console forwarding, write failures)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
