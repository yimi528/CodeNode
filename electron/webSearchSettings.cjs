'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const modelStore = require('./modelStore.cjs');
const webSearch = require('./tools/impl/webSearchTool.cjs');

const fileOf = userDataDir => path.join(userDataDir, 'web-search.json');

function readRaw(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(userDataDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('联网搜索配置格式错误');
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function runtimeSettings(userDataDir, legacyConfig) {
  const raw = readRaw(userDataDir);
  if (!raw) return webSearch.parseWebSearchConfig(legacyConfig?.webSearch || legacyConfig || {});
  let apiKey = '';
  let apiKeyError = false;
  try { apiKey = modelStore.decryptSecret(raw.apiKey || ''); }
  catch { apiKeyError = true; }
  const parsed = webSearch.parseWebSearchConfig({ ...raw, apiKey });
  if (apiKeyError) parsed.problems.push('API Key 无法从系统安全存储解密');
  return { ...parsed, apiKeyError };
}

function publicSettings(userDataDir, legacyConfig) {
  const settings = runtimeSettings(userDataDir, legacyConfig);
  const { apiKey, ...rest } = settings;
  return { ...rest, apiKey: '', apiKeySet: !!apiKey, apiKeyPreview: modelStore.maskApiKey(apiKey) };
}

function normalizeInput(input, previous) {
  const candidate = { ...(input || {}) };
  const provider = String(candidate.provider || candidate.backend || 'searxng').trim().toLowerCase();
  if (!candidate.endpoint && webSearch.DEFAULT_ENDPOINTS[provider]) candidate.endpoint = webSearch.DEFAULT_ENDPOINTS[provider];
  if (!String(candidate.apiKey || '').trim() && previous && previous.provider === provider) candidate.apiKey = previous.apiKey;
  return webSearch.parseWebSearchConfig(candidate);
}

function writeSettings(userDataDir, input, legacyConfig) {
  const previous = runtimeSettings(userDataDir, legacyConfig);
  const settings = normalizeInput(input, previous);
  if (settings.problems.length) throw new Error(settings.problems.join('；'));
  const persisted = {
    version: 1,
    enabled: settings.enabled,
    provider: settings.provider,
    endpoint: settings.endpoint,
    apiKey: settings.apiKey ? modelStore.encryptSecret(settings.apiKey) : '',
    engineId: settings.engineId,
    maxResults: settings.maxResults,
    timeoutMs: settings.timeoutMs,
    networkAllowed: settings.networkAllowed,
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  const target = fileOf(userDataDir);
  const temp = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(persisted, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {} }
  return publicSettings(userDataDir, legacyConfig);
}

async function checkSettings(userDataDir, input, legacyConfig) {
  const previous = runtimeSettings(userDataDir, legacyConfig);
  const settings = normalizeInput(input, previous);
  if (settings.problems.length) return { ok: false, error: settings.problems.join('；') };
  if (!settings.enabled) return { ok: true, count: 0, provider: settings.provider, message: '联网搜索已关闭；配置格式有效。' };
  try {
    const result = await webSearch.performSearch(settings, 'CodeNode desktop agent', 1);
    return { ok: true, count: result.results.length, provider: result.provider, sample: result.results[0] || null };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

module.exports = { readRaw, runtimeSettings, publicSettings, normalizeInput, writeSettings, checkSettings, fileOf };
