'use strict';
const { execFile } = require('child_process');
const config = require('../../config/agent.backends.json');

// WinINET settings are persisted by Windows. Rust's HTTPS client can fall
// back to them, while its WebSocket client needs explicit proxy variables.
// Read only routing fields; never copy browser/account credentials.
function readWindowsProxy() {
  const command = "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=$p.ProxyEnable;server=$p.ProxyServer;bypass=$p.ProxyOverride}|ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: config.requestTimeoutMs, encoding: 'utf8' },
    (error, stdout) => {
      if (error) { reject(new Error('无法读取 Windows 系统代理')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Windows 系统代理数据无效')); }
    }));
}
function parseMacProxy(stdout) {
  const fields = Object.fromEntries(Array.from(stdout.matchAll(/^ {2}(\w+) *: *([^\r\n]*)$/gm), match => [match[1], match[2].trim()]));
  const endpoint = name => {
    const host = fields[name + 'Proxy'];
    const port = Number(fields[name + 'Port']);
    if (fields[name + 'Enable'] !== '1' || !host || !Number.isInteger(port) || port <= 0 || port > 65535) return '';
    return (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + port;
  };
  const entries = [['http', endpoint('HTTP')], ['https', endpoint('HTTPS')]].filter(([,address]) => address);
  const exceptionList = stdout.match(/^ {2}ExceptionsList *: *<array> *\{([\s\S]*?)^ {2}\}/m);
  const bypass = (exceptionList?.[1] || '').split('\n').flatMap(line =>
    (line.replace(/^\s*\d+\s*:\s*/, '').trim()).split(',')).join(';');
  return { enabled: entries.length ? 1 : 0, server: entries.map(([kind,address])=>kind+'='+address).join(';'), bypass };
}

function readMacProxy() {
  return new Promise((resolve, reject) => execFile('/usr/sbin/scutil', ['--proxy'],
    { timeout: 2000, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(parseMacProxy(stdout))));
}

function proxyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}
async function launchEnvironment(options = {}) {
  const env = { ...(options.env || process.env) };
  const platform = options.platform || process.platform;
  if (Object.entries(env).some(([key, value]) => /^(?:https?|all)_proxy$/i.test(key) && String(value || '').trim())) {
    return { env, proxySource: 'environment' };
  }
  if (platform !== 'win32' && platform !== 'darwin') return { env, proxySource: 'environment' };
  let settings;
  try { settings = await (options.readProxy || (platform === 'darwin' ? readMacProxy : readWindowsProxy))(); }
  catch { return { env, proxySource: 'system-unavailable' }; }
  if (Number(settings.enabled) !== 1 || !settings.server) return { env, proxySource: 'direct' };
  const servers = {};
  for (const entry of String(settings.server).split(';')) {
    const parts = entry.trim().split('=');
    if (parts.length === 1) servers.all = parts[0];
    else servers[parts[0].toLowerCase()] = parts.slice(1).join('=');
  }
  const https = proxyUrl(servers.https || servers.all);
  const http = proxyUrl(servers.http || servers.all);
  if (https) env.HTTPS_PROXY = https;
  if (http) env.HTTP_PROXY = http;
  if (!https && !http) return { env, proxySource: 'system-unavailable' };
  if (!Object.keys(env).some(key => /^no_proxy$/i.test(key))) {
    const bypass = String(settings.bypass || '').split(';').map(entry => entry.trim().replace(/^\*\./, '.'))
      .filter(entry => entry && !/[<>*]/.test(entry));
    env.NO_PROXY = [...new Set(['localhost', '127.0.0.1', '::1', ...bypass])].join(',');
  }
  return { env, proxySource: platform === 'darwin' ? 'macos-system' : 'windows-system' };
}
module.exports = { launchEnvironment, proxyUrl, readWindowsProxy, parseMacProxy };
