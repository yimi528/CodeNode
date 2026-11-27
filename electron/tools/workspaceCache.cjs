'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { shouldSkipDir, isSensitivePath } = require('./fsCore.cjs');
const VERSIONED = new Set(['search_files', 'find_files', 'scan_project', 'analyze_project', 'project_info', 'code_review']);

// A bounded content snapshot is a cache validity check, never a cached source of tool results.
async function fingerprint(root, signal) {
  if (!root) return null;
  const hash = createHash('sha256'), queue = [''];
  let entries = 0, bytes = 0;
  try {
    const realRoot = await fs.promises.realpath(root);
    while (queue.length) {
      signal?.throwIfAborted();
      const dir = queue.shift() || '';
      const items = (await fs.promises.readdir(path.join(realRoot, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (++entries > 5000) return null;
        const relative = dir ? dir + '/' + item.name : item.name;
        hash.update(relative + '\0');
        if (item.isSymbolicLink()) return null;
        if (item.isDirectory()) {
          hash.update('directory\0');
          if (!shouldSkipDir(item.name, relative)) queue.push(relative);
        } else if (item.isFile() && !isSensitivePath(relative)) {
          const file = path.join(realRoot, relative), before = await fs.promises.stat(file);
          if (bytes + before.size > 16 * 1024 * 1024) return null;
          for await (const content of fs.createReadStream(file, { highWaterMark: 65536 })) {
            signal?.throwIfAborted(); bytes += content.length;
            if (bytes > 16 * 1024 * 1024) return null;
            hash.update(content);
          }
          const after = await fs.promises.stat(file);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
          hash.update('\0');
        }
      }
    }
    return hash.digest('hex');
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

function createVersions(root, enabled, context = root) {
  return {
    version(tool, signal, args = {}) {
      const target = require('./paths.cjs').resolveToolPath(context, args.path || '.');
      const relative = target ? path.relative(path.resolve(root || '.'), target) : '..';
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return Promise.resolve(null);
      if (String(args.path || '').split(/[\\/]/).some(part => shouldSkipDir(part))) return Promise.resolve(null);
      return enabled && VERSIONED.has(tool) ? fingerprint(root, signal) : Promise.resolve(null);
    },
    async valid(tool, args, cached, version, signal) {
      if (tool === 'read_file') return require('./readFileCache.cjs').matchesCurrentFile(context, args, cached.result, signal);
      if (!enabled) return true;
      // Listings are cheap and may explicitly target ignored/build directories. Always refresh them.
      if (tool === 'list_directory') return false;
      return !VERSIONED.has(tool) || !!version && cached.version === version;
    },
  };
}

module.exports = { createVersions, fingerprint };
