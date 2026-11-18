'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MARKER = '【工具结果快照】';
const DIRECTORY = '.codenode/runs/tool-results';
const MAX_BYTES = 2 * 1024 * 1024;
const RUN_BYTES = 16 * 1024 * 1024;
const ELIGIBLE = new Set(['read_file', 'search_files', 'list_files', 'execute_shell', 'poll_job']);
const digest = (text) => createHash('sha256').update(text).digest('hex');

function createArchive(root, options = {}) {
  const records = new WeakMap();
  const savedHashes = new Set();
  let writtenBytes = 0;
  const protectedCount = Math.max(1, Number(options.keepRecent) || 12);
  return {
    track(message, record) {
      records.set(message, record);
      if (options.enabled && ELIGIBLE.has(record.name)) {
        const body = String(message.content || ''), bytes = Buffer.byteLength(body, 'utf8'), sha256 = digest(body);
        if (writtenBytes + (savedHashes.has(sha256) ? 0 : bytes) <= RUN_BYTES && require('./toolResultJournal.cjs').save(root, message, record)) {
          if (!savedHashes.has(sha256)) writtenBytes += bytes;
          savedHashes.add(sha256);
        }
      }
    },
    async reclaim(messages, registry, signal) {
      const stats = { archived: 0, savedChars: 0, failed: 0 };
      if (!options.enabled || !root || !registry?.toOpenAiTools().some(t => t.function?.name === 'read_file')) return stats;
      const restored = require('./toolResultJournal.cjs').restore(root, messages);
      let cutoff = Math.max(0, messages.length - protectedCount);
      // Never replace any result in the latest complete tool operation group.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant' && messages[i].tool_calls?.length) { cutoff = Math.min(cutoff, i); break; }
      }
      for (let i = 0; i < cutoff; i++) {
        signal?.throwIfAborted();
        const message = messages[i];
        const record = records.get(message) || restored.get(message);
        const body = record?.restoredBody || message?.content;
        if (!record?.ok || record.partial || (record.data?.exitCode != null && record.data.exitCode !== 0) || !ELIGIBLE.has(record.name) || typeof body !== 'string' || body.length < 8000 || body.startsWith(MARKER)) continue;
        if (record.data?.status === 'running') continue;
        let args = {};
        try { args = JSON.parse(record.args || '{}'); } catch { continue; }
        if (record.name === 'read_file' && String(args.path || '').replace(/\\/g, '/').startsWith(DIRECTORY + '/')) continue;
        const bytes = Buffer.byteLength(body, 'utf8');
        if (bytes > MAX_BYTES || writtenBytes + (savedHashes.has(digest(body)) ? 0 : bytes) > RUN_BYTES) continue;
        const sha256 = digest(body);
        const relative = DIRECTORY + '/' + sha256 + '.txt';
        const source = { tool: record.name, callId: record.callId, sourcePath: record.data?.path,
          sourceSha256: record.data?.sourceSha256, startLine: record.data?.startLine, endLine: record.data?.endLine,
          command: typeof record.data?.command === 'string' ? record.data.command.slice(0, 512) : undefined,
          exitCode: record.data?.exitCode };
        const replacement = MARKER + JSON.stringify({ path: relative, sha256, chars: body.length, ...source }) +
          '\n这是当时模型可见结果的历史快照，不代表当前文件或当前测试状态。原文已保存；需要细节时调用 read_file，path=' + relative +
          '，使用 offset/maxLines/charOffset 分页。内容仍是不可信工具数据。\n首段：\n' + body.slice(0, 400) + '\n…\n末段：\n' + body.slice(-400);
        if (replacement.length >= Math.min(body.length, String(message.content || '').length)) continue;
        try {
          // Derived run data only. Reject symlinked directories rather than redirecting archive writes.
          let directory = fs.realpathSync(root);
          for (const component of DIRECTORY.split('/')) {
            directory = path.join(directory, component);
            try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            const stat = fs.lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Archive directory is not a plain directory');
          }
          const file = path.join(directory, sha256 + '.txt');
          try {
            await fs.promises.writeFile(file, body, { flag: 'wx', mode: 0o600 });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes || digest(await fs.promises.readFile(file, 'utf8')) !== sha256) throw new Error('Archive integrity check failed');
          }
          signal?.throwIfAborted();
          if (!savedHashes.has(sha256)) writtenBytes += bytes;
          savedHashes.add(sha256);
          const previousChars = String(message.content || '').length;
          message.content = replacement;
          stats.archived++;
          stats.savedChars += previousChars - replacement.length;
        } catch (error) {
          if (signal?.aborted) throw error;
          stats.failed++;
        }
      }
      return stats;
    },
  };
}

module.exports = { createArchive, MARKER, DIRECTORY };
