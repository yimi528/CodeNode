'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profiles = {
  codex: { variable: 'CODEX_HOME', directory: '.codex', files: ['config.toml', 'auth.json', 'AGENTS.md', 'AGENTS.override.md', 'requirements.toml', 'rules', 'skills', 'hooks', 'hooks.json'] },
  hermes: { variable: 'HERMES_HOME', directory: '.hermes', files: ['config.yaml', '.env', 'auth.json', 'SOUL.md', 'skills', 'hooks'] },
};

function within(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function privateDirectory(directory) {
  try { fs.mkdirSync(directory, {mode: 0o700}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Agent 运行目录无效');
}

// Both agents write databases and logs during session/new, even for read-only tasks.
// Keep mutable state inside CodeNode's existing writable root. Native configuration
// and credentials remain in the user's CLI profile and are never copied or parsed here.
function runtimeEnvironment(settings, policy, env) {
  const spec = profiles[settings.backend];
  const command = String(require('../../config/agent.backends.json').commands[settings.backend] || '');
  if (!spec || !policy?.externalAgent || !policy.agentRuntimeDir || process.platform === 'win32' ||
      (settings.executable && path.basename(settings.executable) !== command)) return {};
  const source = path.resolve(env[spec.variable] || path.join(os.homedir(), spec.directory));
  const roots = policy.writeRoots || [];
  if (roots.some(root => within(root, source))) return {};
  const parent = policy.agentRuntimeDir;
  if (!roots.some(root => within(root, parent))) throw new Error('当前沙箱未提供 Agent 状态目录');
  privateDirectory(parent);
  const scope = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
  const directory = path.join(parent, settings.backend + '-' + scope);
  privateDirectory(directory);
  for (const file of spec.files) {
    const original = path.join(source, file);
    if (!fs.existsSync(original)) continue;
    try { fs.symlinkSync(original, path.join(directory, file)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return { [spec.variable]: directory };
}
module.exports = { runtimeEnvironment };
