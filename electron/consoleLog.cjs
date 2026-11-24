'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** macOS app bundles must remain sealed after signing; Windows keeps its portable log path. */
function setupConsoleLog({ userDataDir, platform = process.platform, executable = process.execPath }, output = console) {
  try {
    const dir = platform === 'darwin' ? path.join(userDataDir, 'logs') : path.join(path.dirname(executable), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'console.log');
    const toStr = value => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack || String(value);
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    for (const level of ['log', 'info', 'warn', 'error']) {
      const original = output[level];
      output[level] = function (...args) {
        try { fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + args.map(toStr).join(' ') + '\n', 'utf8'); } catch {}
        if (original) original.apply(output, args);
      };
    }
    return file;
  } catch { return null; }
}

module.exports = { setupConsoleLog };
