#!/usr/bin/env node
/**
 * startup-guard-test.cjs —— 启动自检：`ELECTRON_RUN_AS_NODE` 必须变成**可诊断的启动失败**。
 *
 * 背景（2026-11-18 实机故障）：从某个设置了 `ELECTRON_RUN_AS_NODE` 的父进程（Electron 系的
 * IDE / Agent harness 的 shell）启动本应用时，Electron 会以**纯 Node** 身份运行 `main.cjs` ——
 * 进程起来了、不建窗口、不报错、**退出码 0**。对外表现是「双击图标毫无反应」：
 * 启动器认为成功（Process.Start 确实返回了 pid），用户却什么也看不到，而且没有任何日志。
 *
 * 判据：
 *   A. 带该变量启动 → 退出码 **非 0**，stderr 点明变量名与后果；
 *   B. 同时在 exe 目录写 `logs/startup-error.log`（GUI 双击看不到 stderr，日志是唯一线索）；
 *   C. 不带该变量时**不会**被误杀（用 `--codenode-selftest` 走一遍真实 Electron 启动路径：
 *      它不是 Node 模式，自检应当正常跑完，而不是撞上我们的拦截）。
 */
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const electronBinary = require(path.join(ROOT, 'node_modules/electron'));
const mainEntry = path.join(ROOT, 'electron/main.cjs');
const logFile = path.join(path.dirname(electronBinary), 'logs', 'startup-error.log');

function runElectron(args, envPatch) {
  const env = { ...process.env, ...envPatch };
  // 让子进程一定看到我们给的取值（包括「显式删除」的情况）
  for (const [key, value] of Object.entries(envPatch)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(electronBinary, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
}

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

try { fs.rmSync(logFile, { force: true }); } catch {}

// ---- A/B. 带 ELECTRON_RUN_AS_NODE 启动：必须响亮地失败 ----
{
  const result = runElectron([mainEntry], { ELECTRON_RUN_AS_NODE: '1' });
  const stderr = String(result.stderr || '');
  check('A1 带 ELECTRON_RUN_AS_NODE 启动 → 退出码非 0（不再假装成功）',
    result.status !== 0, 'status=' + result.status);
  check('A2 stderr 点明变量名与后果',
    /ELECTRON_RUN_AS_NODE/.test(stderr) && /纯 Node|Node/.test(stderr) && /窗口/.test(stderr),
    JSON.stringify(stderr.slice(0, 120)));
  check('A3 stderr 给出可行修复（清除变量或换启动入口）',
    /Remove-Item Env:ELECTRON_RUN_AS_NODE/.test(stderr) && /资源管理器|开始菜单/.test(stderr),
    JSON.stringify(stderr.slice(0, 160)));
  check('B1 在 exe 目录写了 startup-error.log（GUI 双击时唯一线索）',
    fs.existsSync(logFile), logFile);
  if (fs.existsSync(logFile)) {
    const logged = fs.readFileSync(logFile, 'utf8');
    check('B2 日志里记下变量取值与同一段原因',
      /ELECTRON_RUN_AS_NODE=1/.test(logged) && /无法启动/.test(logged), JSON.stringify(logged.slice(0, 120)));
  }
}

// ---- C. 不带该变量：自检路径照常跑（证明拦截没有误杀正常启动） ----
{
  const result = runElectron([mainEntry, '--codenode-selftest'], { ELECTRON_RUN_AS_NODE: undefined });
  const combined = String(result.stdout || '') + String(result.stderr || '');
  check('C1 正常启动（真实 Electron）不会被拦截', !/ELECTRON_RUN_AS_NODE/.test(combined),
    JSON.stringify(combined.slice(0, 160)));
  check('C2 自检真的跑完了（有 codenode-selftest 结果）',
    /codenode-selftest/.test(combined), JSON.stringify(combined.slice(0, 160)));
}

try { fs.rmSync(logFile, { force: true }); } catch {}

console.log('\n' + (failures === 0
  ? 'STARTUP GUARD TEST: PASS（Node 模式被改成可诊断的失败，正常启动不受影响）'
  : 'STARTUP GUARD TEST: FAIL —— ' + failures + ' 项断言未通过'));
process.exitCode = failures === 0 ? 0 : 1;
