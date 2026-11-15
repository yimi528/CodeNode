'use strict';
// Workspace checkpoints and the immutable conversation projection share one local journal.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const worktree = require('./worktree.cjs');
const { withFileLock } = require('./fileLock.cjs');
const { redact } = require('./redaction.cjs');
const queues = new Map();
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
function directory(owner) {
  for (const rel of ['.codenode', '.codenode/branches']) {
    const file = path.join(owner, rel);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isDirectory())) throw Error('分支记录路径不可为链接或普通文件');
    fs.mkdirSync(file, { recursive: true });
  }
  return path.join(owner, '.codenode/branches');
}
function journal(owner) {
  const file = path.join(directory(owner), 'events.jsonl');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('分支日志不可为链接');
  return file;
}
function events(owner) {
  const file = journal(owner);
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > MAX_JOURNAL_BYTES) throw Error('分支日志超出读取上限');
  const raw = fs.readFileSync(file, 'utf8');
  if (raw && !raw.endsWith('\n')) throw Error('分支日志不完整，请先恢复记录');
  let previous = '';
  return raw.split('\n').filter(Boolean).map(line => {
    const event = JSON.parse(line), { hash, ...payload } = event;
    if (payload.previous !== previous || hash !== digest(JSON.stringify(payload))) throw Error('分支日志校验失败');
    previous = hash; return event;
  });
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function append(owner, kind, value) {
  const file = journal(owner);
  return withFileLock(file, () => {
    const rows = events(owner);
    const event = { sequence: rows.length + 1, previous: rows.at(-1)?.hash || '', kind, value, at: new Date().toISOString() };
    const line = JSON.stringify({ ...event, hash: digest(JSON.stringify(event)) }) + '\n';
    if ((fs.existsSync(file) ? fs.statSync(file).size : 0) + Buffer.byteLength(line) > MAX_JOURNAL_BYTES) throw Error('分支日志已满');
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return event;
  });
}
async function git(root, args, options = {}) {
  const result = await worktree.runGit(root, args, options);
  if (!result.ok) throw Error(`Git 操作失败：${result.error || result.stderr || result.stdout}`.slice(0, 1200));
  return result.stdout.trim();
}
async function ownerOf(root, options) {
  const absolute = fs.realpathSync(root);
  const common = await git(absolute, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options);
  if (path.basename(common) !== '.git') throw Error('会话分支需要具有 .git 目录的普通仓库');
  const owner = fs.realpathSync(path.dirname(common));
  if (absolute !== owner && !worktree.isManagedPath(owner, absolute)) throw Error('当前目录不是仓库根目录或受管工作树');
  return owner;
}
function projection(owner) {
  const state = /** @type {any} */ ({ checkpoints: [], branches: [], contexts: {}, previews: {} });
  for (const row of events(owner)) {
    if (row.kind === 'checkpoint') state.checkpoints.push(row.value);
    if (row.kind === 'branch') state.branches.push(row.value);
    if (row.kind === 'adopt_preview') state.previews[row.value.token] = row.value;
    if (row.kind === 'context') state.contexts[row.value.id] = row.value.context;
    if (row.kind === 'adopted' || row.kind === 'archived') {
      const branch = state.branches.find(item => item.id === row.value.id);
      if (branch) Object.assign(branch, row.value, { status: row.kind === 'adopted' ? 'accepted' : 'archived' });
    }
  }
  return state;
}
function serialize(owner, action) {
  const prior = queues.get(owner) || Promise.resolve();
  const next = prior.catch(() => {}).then(action);
  queues.set(owner, next);
  return next.finally(() => { if (queues.get(owner) === next) queues.delete(owner); });
}
function contextOf(input) {
  const raw = JSON.stringify(input || {});
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw Error('会话检查点超过 2MB，请先压缩或减少历史');
  const context = JSON.parse(redact(raw));
  if (!Array.isArray(context.messages)) context.messages = [];
  // Recover a conversation view; backend session IDs and approval tokens are never copied.
  return { messages: context.messages, label: String(context.label || '').slice(0, 200), graph: context.graph || { nodes: [], edges: [] }, sessions: context.sessions || {}, order: context.order || [], activeId: context.activeId || null, projectFile: context.projectFile || null };
}
async function list(root, options) {
  const owner = await ownerOf(root, options), state = projection(owner);
  const managed = await worktree.managedWorktrees(owner, options);
  return { owner, ...state, activeId: state.branches.find(branch => worktree.normalizePath(branch.path) === worktree.normalizePath(root))?.id || 'main',
    branches: state.branches.map(branch => ({ ...branch, available: managed.some(item => worktree.normalizePath(item.path) === worktree.normalizePath(branch.path)) })) };
}
async function checkpoint(root, input, options) {
  const owner = await ownerOf(root, options);
  return serialize(owner, async () => {
    const context = contextOf(input.context), id = randomUUID();
    const head = await git(root, ['rev-parse', 'HEAD'], options);
    const indexFile = path.join(directory(owner), id + '.index');
    const gitOptions = { ...options, indexFile };
    try {
      await git(root, ['read-tree', head], gitOptions);
      await git(root, ['add', '--all', '--', '.', ':!.codenode'], gitOptions);
      const tree = await git(root, ['write-tree'], gitOptions);
      const commit = await git(root, ['-c', 'user.name=CodeNode', '-c', 'user.email=codenode@localhost', 'commit-tree', tree, '-p', head, '-m', 'CodeNode workspace checkpoint ' + id], options);
      await git(root, ['update-ref', 'refs/codenode/checkpoints/' + id, commit], options);
      const value = { id, label: String(input.label || '检查点').slice(0, 120), commit, tree, head, sourcePath: fs.realpathSync(root), createdAt: new Date().toISOString(), context };
      append(owner, 'checkpoint', value); return value;
    } finally { for (const suffix of ['', '.lock']) { try { fs.unlinkSync(indexFile + suffix); } catch {} } }
  });
}
async function fork(root, checkpointId, name, options) {
  const owner = await ownerOf(root, options);
  return serialize(owner, async () => {
    const baseline = projection(owner).checkpoints.find(item => item.id === checkpointId);
    if (!baseline) throw Error('检查点不存在');
    const actual = await git(owner, ['rev-parse', baseline.commit + '^{tree}'], options);
    if (actual !== baseline.tree) throw Error('检查点代码对象不完整');
    const id = randomUUID(), slug = 'conversation-' + id;
    const created = await worktree.createWorktree(owner, { name: slug, base: baseline.commit }, options);
    if (!created.ok) throw Error(created.message);
    const value = { id, name: String(name || '新方案').slice(0, 100), slug, path: created.path, branch: created.branch, checkpointId, baseCommit: baseline.commit, baseTree: baseline.tree, status: 'active', createdAt: new Date().toISOString() };
    append(owner, 'branch', value); append(owner, 'context', { id, context: baseline.context }); return value;
  });
}
async function saveContext(root, context, options) {
  const state = await list(root, options);
  append(state.owner, 'context', { id: state.activeId, context: contextOf(context) });
  return { id: state.activeId };
}
async function compare(root, id, options) {
  const state = await list(root, options), branch = state.branches.find(item => item.id === id);
  if (!branch?.available) throw Error('方案工作树不存在；原记录仍保留');
  const snapshot = await checkpoint(branch.path, { label: '比较 ' + branch.name, context: state.contexts[id] }, options);
  const diff = await git(state.owner, ['diff', '--no-ext-diff', '--no-textconv', '--stat', branch.baseCommit, snapshot.commit], options);
  const patch = await git(state.owner, ['diff', '--no-ext-diff', '--no-textconv', branch.baseCommit, snapshot.commit], options);
  return { id, name: branch.name, snapshotId: snapshot.id, commit: snapshot.commit, diff, patch, truncated: patch.length >= 8000, context: state.contexts[id] };
}
async function previewAdopt(root, id, options) {
  const state = await list(root, options), branch = state.branches.find(item => item.id === id);
  if (fs.realpathSync(root) !== state.owner) throw Error('请先切回主工作区，再采用方案');
  if (!branch?.available || branch.status === 'archived') throw Error('方案不可采用');
  const preview = await worktree.inspectMerge(state.owner, branch.slug, options);
  if (!preview.ok) throw Error(preview.message);
  const source = await checkpoint(branch.path, {label:'比较 采用预览 '+branch.name,context:state.contexts[id]}, options);
  const targetTree = await git(root, ['rev-parse',preview.targetHead+'^{tree}'], options);
  // Rebase the target tree onto the saved dirty baseline in an object only. This avoids
  // treating pre-existing user edits as new branch edits when the user commits them later.
  const target = await git(root, ['-c','user.name=CodeNode','-c','user.email=codenode@localhost','commit-tree',targetTree,'-p',branch.baseCommit,'-m','CodeNode adoption comparison'],options);
  const merged = await worktree.runGit(root,['merge-tree','--write-tree',target,source.commit],options);
  if(!merged.ok)throw Error('预合并发现冲突；主工作区未改变，方案保留。'+merged.stdout.slice(0,700));
  const tree=merged.stdout.split(/\r?\n/)[0].trim();
  if(!/^[a-f0-9]{40,64}$/.test(tree))throw Error('无法确认预合并代码树');
  const value={...preview,id,token:randomUUID(),snapshotCommit:source.commit,mergedTree:tree};
  append(state.owner,'adopt_preview',value);return value;
}
async function adopt(root, id, input, options) {
  const owner = await ownerOf(root, options);
  return serialize(owner, async () => {
    if(fs.realpathSync(root)!==owner)throw Error('请先切回主工作区');
    const state = await list(root, options), branch = state.branches.find(item => item.id === id);
    const preview=state.previews[input?.token];
    if(!branch?.available||branch.status!=='active'||preview?.id!==id)throw Error('采用预览无效，请重新预览');
    const current=await worktree.inspectMerge(owner,branch.slug,options);
    if(!current.ok)throw Error(current.message);
    for(const key of ['targetHead','sourceHead','targetBranch','pendingDigest'])if(current[key]!==preview[key])throw Error('预览后代码状态变化，请重新预览');
    const commit=await git(owner,['-c','user.name=CodeNode','-c','user.email=codenode@localhost','commit-tree',preview.mergedTree,'-p',preview.targetHead,'-p',preview.snapshotCommit,'-m','Adopt CodeNode conversation: '+branch.name],options);
    await git(owner,['merge','--ff-only','--no-edit',commit],options);
    append(owner, 'adopted', { id, adoptedAt: new Date().toISOString(), head: commit, validation: 'required' });
    return { head:commit, validation:'required', message:'代码已采用，目标工作区需要重新运行验证；源分支的通过状态不继承。' };
  });
}
async function archive(root, id, options) {
  const state = await list(root, options), branch = state.branches.find(item => item.id === id);
  if (!branch) throw Error('方案不存在');
  if (state.activeId === id) throw Error('请先切换到其他方案再归档');
  append(state.owner, 'archived', { id, archivedAt: new Date().toISOString() });
  return { id };
}
module.exports = { list, checkpoint, fork, saveContext, compare, previewAdopt, adopt, archive, events, ownerOf };
