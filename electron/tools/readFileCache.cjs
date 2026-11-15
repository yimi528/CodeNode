'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { resolveFileFuzzy, isSensitivePath } = require('./impl/shared.cjs');
const { resolveToolPath, roots, sensitiveFile } = require('./paths.cjs');

// A cached read is a snapshot of file bytes, not a promise that the workspace stayed unchanged.
// Hash in bounded chunks: PDF/Office reads may be 20 MiB and must not block the main thread.
async function matchesCurrentFile(context, args, result, signal) {
  const { projectRoot: root } = roots(context);
  const expected = result?.data?.sourceSha256;
  const relative = String(args.path || '').trim();
  if (!root || !relative || !expected || isSensitivePath(relative)) return false;
  let handle;
  try {
    signal?.throwIfAborted();
    let file = resolveToolPath(context, relative);
    if (!file) return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = resolveFileFuzzy(root, relative);
    if (!file) return false;
    const realFile = fs.realpathSync(file);
    if (sensitiveFile(context, file)) return false;
    // Re-resolve fuzzy paths each time: an exact file may have appeared since the original read.
    const oldFile = resolveToolPath(context, result.data.matched || relative);
    if (!oldFile || fs.realpathSync(oldFile) !== realFile) return false;
    handle = await fs.promises.open(realFile, 'r');
    const before = await handle.stat();
    const maxBytes = 20 * 1024 * 1024;
    if (!before.isFile() || before.size > maxBytes) return false;
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) return false;
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    // Stat alone misses same-size edits with restored timestamps; compare the actual bytes.
    return 'sha256:' + hash.digest('hex') === expected && fs.realpathSync(file) === realFile;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false; // Deleted, unreadable, retargeted or unknown-version files must use the real tool.
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = { matchesCurrentFile };
