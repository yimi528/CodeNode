'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

// 只复制候选源码到临时目录；期望值和判分逻辑始终留在父进程，不执行候选测试。
// 这提供测试完整性检查，不是执行不可信代码的操作系统安全沙箱。
/** @param {string} workspace @param {any} task @param {any} options */
function gradeCoding(workspace, task, options = {}) {
  let containerName = null;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-coding-grade-'));
  function regular(relative) {
    const parts = relative.split('/');
    if (parts.some(p => !p || p === '..' || p === '.')) throw Error('非法候选路径');
    let file = workspace;
    for (const part of parts) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('候选路径包含符号链接：' + relative);
    }
    return file;
  }
  function copyTree(relative) {
    const file = regular(relative);
    const dest = path.join(stage, relative);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(file)) copyTree(relative + '/' + name);
    } else if (stat.isFile()) {
      fs.copyFileSync(file, dest); fs.chmodSync(dest,0o644);
    } else throw Error('候选源码必须是普通文件：' + relative);
  }
  try {
    if (!Array.isArray(task.behaviorCases) || !task.behaviorCases.length) throw Error('缺少评测端行为验收用例');
    for (const test of task.behaviorCases) {
      if (!/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.cjs$/.test(test.module) ||
          !/^[a-zA-Z_$][\w$]*$/.test(test.export) || !Array.isArray(test.args) ||
          !Object.hasOwn(test, 'expected')) throw Error('行为验收用例格式无效');
    }
    for (const [relative, original] of Object.entries(task.fixture)) {
      if (relative.startsWith('src/')) continue;
      if (fs.readFileSync(regular(relative), 'utf8') !== original) {
        return { pass: false, status: 'FAIL', integrityStatus: 'VIOLATION', detail: '受保护文件被修改：' + relative };
      }
    }
    copyTree('src');
    const input = task.behaviorCases.map(({ module, export: name, args }) => ({ module, export: name, args }));
    let result, raw;
    if (options.backend === 'docker') {
      const image = options.image || process.env.CODENODE_EVAL_GRADER_IMAGE || 'node:22.23.1-bookworm-slim';
      const inspect = spawnSync('docker', ['image','inspect','--format','{{.Id}}',image], {encoding:'utf8',timeout:10000});
      if (inspect.status !== 0) return {pass:false,status:'ERROR',detail:'Docker verifier 或已固定镜像不可用；未降级为宿主执行'};
      const imageId = inspect.stdout.trim();
      fs.chmodSync(stage,0o755);
      const responseDir = path.join(stage, '.response'); fs.mkdirSync(responseDir); fs.chmodSync(responseDir,0o777);
      containerName = 'codenode-grade-' + require('node:crypto').randomUUID();
      result = spawnSync('docker', ['run','--rm','--user','65534:65534','--name',containerName,'--network','none','--read-only','--cap-drop','ALL',
        '--security-opt','no-new-privileges','--pids-limit','64','--cpus','1','--memory','256m','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
        '-v',stage+':/workspace:ro','-v',responseDir+':/response:rw','-v',path.join(__dirname,'coding-candidate.cjs')+':/opt/candidate.cjs:ro',
        '-w','/workspace','-e','CODENODE_CANDIDATE_RESULT=/response/result.json','-i',imageId,'node','/opt/candidate.cjs'],
        {encoding:'utf8',input:JSON.stringify(input),timeout:10000,maxBuffer:1024*1024});
      raw = fs.existsSync(path.join(responseDir,'result.json')) ? fs.readFileSync(path.join(responseDir,'result.json'),'utf8') : '';
      if (result.status === 125 || result.status === 127) return {pass:false,status:'ERROR',detail:'Docker verifier 启动失败：'+String(result.stderr).slice(0,1000)};
    } else if (!options.backend || options.backend === 'process') {
      let worker = path.join(__dirname, 'coding-candidate.cjs');
      const restricted = options.restrictedUser === true && process.platform !== 'win32' && process.getuid?.() === 0;
      if (restricted) {
        fs.chmodSync(stage, 0o755); worker = path.join(stage, '.worker.cjs');
        fs.copyFileSync(path.join(__dirname, 'coding-candidate.cjs'), worker); fs.chmodSync(worker, 0o444);
      }
      result = spawnSync(process.execPath, [worker], {
        cwd: stage, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        ...(restricted ? { uid: 65534, gid: 65534 } : {}),
        input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      });
      raw = String(result.output[3] || '');
    } else return {pass:false,status:'ERROR',detail:'未知 verifier backend'};
    if (result.status !== 0) return { pass: false, status: result.error && 'code' in result.error && result.error.code === 'ENOENT' ? 'ERROR' : 'FAIL', detail: `候选执行 exit=${result.status}；${String(result.error || result.stderr).slice(0, 1000)}` };
    let payload;
    try { payload = JSON.parse(raw); }
    catch { return { pass: false, detail: '候选未返回完整行为结果，stdout 成功标记不能作为验收证据' }; }
    if (payload?.version !== 1 || !Array.isArray(payload.outcomes) || payload.outcomes.length !== task.behaviorCases.length) {
      return { pass: false, detail: '候选行为结果数量或协议不匹配' };
    }
    for (let i = 0; i < task.behaviorCases.length; i++) {
      const test = task.behaviorCases[i], actual = payload.outcomes[i];
      if (actual?.ok !== true || !isDeepStrictEqual(actual.value, test.expected)) {
        return { pass: false, detail: `行为断言 ${test.id || i + 1} 失败：${test.module}.${test.export}；期望=${JSON.stringify(test.expected)}，实际=${JSON.stringify(actual).slice(0, 1000)}` };
      }
    }
    return { pass: true, status: 'PASS', integrityStatus: 'CLEAN', detail: `独立行为验收：评测端比较 ${task.behaviorCases.length} 项结果全部通过` };
  } catch (error) {
    return { pass: false, status: /缺少评测端|用例格式/.test(String(error.message)) ? 'ERROR' : 'FAIL', integrityStatus: /符号链接|ENOENT/.test(String(error.message)) ? 'VIOLATION' : 'UNKNOWN', detail: String(error.message || error) };
  } finally {
    if (containerName) spawnSync('docker', ['rm','-f',containerName], {encoding:'utf8',timeout:10000});
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
module.exports = { gradeCoding };
