'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('node:os');
const { spawn } = require('child_process');
const { guardedInteractiveSpawn, killSandboxed } = require('../sandbox.cjs');
const config = require('../../config/agent.backends.json');
const { killProcessTree } = require('../processTree.cjs');
const { launchEnvironment } = require('./network.cjs');
const { redact } = require('../redaction.cjs');

// Some Agents ship a Windows executable whose name differs from the documented
// launch name (Qoder's `qodercli`/`qoder`, the renamed Claude Code adapter).
// Aliases only widen discovery; the primary name is always tried first.
function commandCandidates(command) {
  const aliases = config.commandAliases?.[command];
  return Array.isArray(aliases) && aliases.length ? [command, ...aliases.filter(alias => typeof alias === 'string' && alias && alias !== command)] : [command];
}
// npm bin targets are usually .js/.mjs, but some packages point at an
// extension-less launcher. Only a Node shebang proves it is safe to run with
// the bundled Node runtime instead of executing it directly.
function isNodeScript(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(200);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return /^#![^\n]*\bnode\b/.test(buffer.subarray(0, read).toString('utf8'));
  } catch { return false; } finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }
}
function resolveInDir(command, dir) {
  if (process.platform === 'win32') {
    const exe = path.join(dir, command + '.exe');
    if (fs.existsSync(exe)) return { command: exe, prefix: [] };
    const packageMap = { opencode: ['opencode-ai', 'bin', 'opencode.exe'], openclaw: ['openclaw', 'openclaw.mjs'] };
    const parts = packageMap[command];
    if (parts) {
      const candidate = path.join(dir, 'node_modules', ...parts);
      if (fs.existsSync(candidate)) return command === 'openclaw' ? { command: process.execPath, prefix: [candidate] } : { command: candidate, prefix: [] };
    }
    const scripts = path.join(dir, command + '.cmd');
    if (fs.existsSync(scripts)) {
      const content = fs.readFileSync(scripts, 'utf8');
      const target = content.match(/"%dp0%\\node_modules\\([^" ]+)"/i);
      if (target) {
        const candidate = path.join(dir, 'node_modules', target[1]);
        const executable = fs.existsSync(candidate);
        if (executable && /\.exe$/i.test(target[1])) return { command: candidate, prefix: [] };
        if (executable && (/\.(?:js|mjs|cjs)$/i.test(target[1]) || isNodeScript(candidate))) return { command: process.execPath, prefix: [candidate] };
      }
    }
    const hermes = path.join(dir, 'hermes.exe'); if (command === 'hermes' && fs.existsSync(hermes)) return { command: hermes, prefix: [] };
    return null;
  }
  const candidate = path.join(dir, command);
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile() ? { command: candidate, prefix: [] } : null;
  } catch { return null; }
}
function commandRoots(env = process.env) {
  const roots = String(env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir));
  if (process.platform === 'darwin') {
    const home = os.homedir();
    roots.push(path.join(home, '.local/bin'), path.join(home, '.opencode/bin'), path.join(home, '.bun/bin'),
      path.join(home, '.volta/bin'), path.join(home, 'Library/pnpm'), '/opt/homebrew/bin', '/usr/local/bin');
  }
  if (process.platform === 'win32' && env.APPDATA) roots.push(path.join(env.APPDATA, 'npm'));
  return [...new Set(roots)];
}
function resolveCommand(command, roots = commandRoots()) {
  if (pathIsAbsolute(command)) {
    if (!fs.existsSync(command)) throw new Error('可执行文件不存在：' + command);
    if (process.platform === 'win32' && /\.(?:mjs|js|py)$/i.test(command)) {
      const runner = /\.py$/i.test(command) ? process.env.PYTHON || 'python' : process.execPath;
      return { command: runner, prefix: [command] };
    }
    return { command, prefix: [] };
  }
  const names = commandCandidates(command);
  for (const name of names) for (const dir of roots) {
    if (!dir) continue;
    const resolved = resolveInDir(name, dir);
    if (resolved) return resolved;
  }
  throw new Error('未找到程序：' + command + (names.length > 1 ? '（别名 ' + names.slice(1).join('、') + ' 也不存在）' : ''));
}
function pathIsAbsolute(value) { return require('path').isAbsolute(value); }

class StdioRpc extends EventEmitter {
  constructor(command, args, cwd, options = {}) {
    super(); this.pending = new Map(); this.sequence = 0; this.closed = false; this.buffer = ''; this.stderrTail=[];
    this.protocolStarted = false; this.stdoutPreamble = []; this.stdoutPreambleBytes = 0;
    this.child = null; this.spawnError = null;
    this.shutdown = null;
    this.ready = (async () => {
      const network = await launchEnvironment();
      const env = { ...network.env, ...(options.env || {}) };
      const roots = commandRoots(env);
      const resolved = resolveCommand(command, roots);
      env.PATH = roots.join(path.delimiter);
      if (resolved.command === process.execPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      this.proxySource = network.proxySource;
      const childArgs = [...resolved.prefix, ...(args || [])];
      if (options.spawn) {
        this.child = options.spawn(resolved.command, childArgs,
          { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } else if (options.policy) {
        this.child = (options.guardedInteractiveSpawn || guardedInteractiveSpawn)(
          { file: resolved.command, args: childArgs, cwd, env },
          { cwd, env, policy: options.policy, context: options.context, detached: process.platform !== 'win32' }
        );
      } else {
        this.child = spawn(resolved.command, childArgs,
          { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      }
      this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', chunk => this.receive(chunk));
      this.child.stderr.on('data', chunk => {const value=String(redact(String(chunk)));this.stderrTail.push(value.slice(-4000));if(this.stderrTail.length>8)this.stderrTail.shift();this.emit('stderr',value.slice(-4000));});
      this.child.on('error', error => { this.spawnError = error; this.disconnected(error); });
      this.child.on('close', (code, signal) => this.disconnected(new Error('Agent 进程退出 (' + (signal || code) + ')'+(this.stderrTail.length?'：'+this.stderrTail.join('\n'):''))));
      this.child.stdin.on('error', error => this.disconnected(error));
    })();
  }
  async send(message) { await this.ready; if (this.closed) throw new Error('Agent 协议连接已关闭'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  async request(method, params, timeout = config.requestTimeoutMs) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const diagnostic=this.stderrTail.slice(-3).join('\n').slice(-1200);
        reject(new Error('Agent 请求超时：' + method + (diagnostic?'；最近输出：'+diagnostic:'')));
      }, timeout);
      this.pending.set(String(id), { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params: params || {} }).catch(error => {
        clearTimeout(timer); this.pending.delete(String(id)); reject(error);
      });
    });
  }
  async respond(id, result) { return this.send({ jsonrpc: '2.0', id, result }); }
  async respondError(id, code, message, data) { return this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data: redact(data) }) } }); }
  receive(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); if (!line.trim()) continue;
      if (Buffer.byteLength(line) > config.maxMessageBytes) { this.disconnected(new Error('Agent 协议消息超过限制')); void this.close(); return; }
      let message;
      try {
        message = JSON.parse(line);
        if (!message || message.jsonrpc !== '2.0' || (!message.method && message.id == null)) throw new Error('非 JSON-RPC 日志行');
      }
      catch {
        // Some real ACP adapters print Rich banners/status rows on stdout even after initialization.
        // JSON-RPC is newline framed, so a line that is not JSON cannot be a partial protocol frame;
        // route bounded noise to diagnostics and keep reading. The hard count/byte cap still fails
        // closed if the process is not actually speaking ACP or floods stdout indefinitely.
        const safeLine=String(redact(line)).slice(0,500),bytes=Buffer.byteLength(line);
        if(this.stdoutPreamble.length<config.maxStdoutNoiseLines&&this.stdoutPreambleBytes+bytes<=config.maxStdoutNoiseBytes){
          this.stdoutPreamble.push(safeLine);this.stdoutPreambleBytes+=bytes;this.stderrTail.push('[stdout noise] '+safeLine);if(this.stderrTail.length>8)this.stderrTail.shift();this.emit('stderr','[stdout noise] '+safeLine);continue;
        }
        this.disconnected(new Error('Agent 返回无效 JSON：'+safeLine)); void this.close(); return;
      }
      this.protocolStarted = true;
      if (message.method) this.emit(message.id != null ? 'request' : 'notification', message);
      else {
        const item = this.pending.get(String(message.id)); if (!item) continue;
        clearTimeout(item.timer); this.pending.delete(String(message.id));
        if (message.error) {
          /** @type {Error & {code?: any, data?: any, method?: string}} */
          const error = new Error(message.error.message || 'Agent 协议错误');
          error.code = message.error.code;
          error.data = redact(message.error.data);
          error.method = item.method;
          item.reject(error);
        } else item.resolve(message.result);
      }
    }
    if (Buffer.byteLength(this.buffer) > config.maxMessageBytes) { this.disconnected(new Error('Agent 协议消息超过限制')); void this.close(); }
  }
  disconnected(error) {
    if (this.closed) return; this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.emit('disconnect', error);
  }
  close() {
    this.shutdown ??= this.stopProcess();
    return this.shutdown;
  }
  async stopProcess() {
    await this.ready.catch(() => {});
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode) return;
    this.disconnected(new Error('Agent 协议连接已关闭'));
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); child.removeListener('close', done); resolve(true); };
      const timer = setTimeout(done, config.shutdownTimeoutMs);
      child.once('close', done);
      if (child.backend) killSandboxed(child, true);
      else killProcessTree(child, true);
    });
    child.stdin?.destroy?.(); child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.();
  }
}
module.exports = { StdioRpc, resolveCommand };
