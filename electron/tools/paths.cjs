'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveInRoot } = require('./impl/shared.cjs');
const { isSensitivePath } = require('./fsCore.cjs');
const approvalRules = require('../approvalRules.cjs');

function roots(context) {
  const projectRoot = path.resolve(typeof context === 'string' ? context : context?.projectRoot?.() || '.');
  const accessRoot = path.resolve(typeof context?.accessRoot === 'function' ? context.accessRoot() : projectRoot);
  return { projectRoot, accessRoot };
}

// Relative names always start at the task project; permission checks use the
// independently granted boundary. Never use a larger boundary as a search cwd.
function resolveToolPath(context, name = '.') {
  if (typeof name !== 'string') return null;
  const { projectRoot, accessRoot } = roots(context);
  const target = resolveInRoot(accessRoot, path.resolve(projectRoot, name));
  if (!target || approvalRules.isProtectedWriteTarget(projectRoot, target)) return null;
  return target;
}

function sensitiveFile(context, file) {
  try {
    const real = fs.realpathSync(file);
    const { projectRoot, accessRoot } = roots(context);
    return [real, path.relative(fs.realpathSync(projectRoot), real), path.relative(fs.realpathSync(accessRoot), real)].some(isSensitivePath);
  } catch { return true; }
}

function workingDirectory(context, cwd) {
  const target = resolveToolPath(context, cwd || '.');
  if (!target || !fs.statSync(target).isDirectory()) throw Error('cwd 不存在或越过授权边界');
  return target;
}

module.exports = { roots, resolveToolPath, sensitiveFile, workingDirectory };
