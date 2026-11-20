const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { extractDocumentText } = require('./tools/impl/documentText.cjs');

const filters = new Map([
  ...['.doc', '.docx', '.docm', '.odt', '.rtf'].map(ext => /** @type {[string, string]} */ ([ext, 'writer_pdf_Export'])),
  ...['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp'].map(ext => /** @type {[string, string]} */ ([ext, 'impress_pdf_Export'])),
  ...['.xls', '.xlsx', '.xlsm', '.xlsb', '.ods'].map(ext => /** @type {[string, string]} */ ([ext, 'calc_pdf_Export'])),
]);
const isOfficeFormat = ext => filters.has(ext);

const profileConfig = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Calc/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>1</value></prop>
  </item>
</oor:items>`;

async function officeExecutable() {
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'office-renderer', 'program', 'soffice.com'));
    for (const folder of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (folder) candidates.push(path.join(folder, 'LibreOffice', 'program', 'soffice.com'));
    }
  } else {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice');
  }
  for (const candidate of new Set(candidates)) {
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

let activeConversions = 0;

/** @returns {Promise<void>} */
function convertToPdf(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, cwd, stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        // soffice.com delegates to soffice.bin. Stop both before removing the profile.
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
      } else child.kill();
    }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('文档转换进程未正常完成'));
    });
  });
}

async function renderOffice(executable, bytes, ext, limit) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codenode-office-preview-'));
  try {
    const profile = path.join(temp, 'profile');
    const profileUser = path.join(profile, 'user');
    await fs.mkdir(profileUser, { recursive: true });
    const input = path.join(temp, `document${ext}`);
    await Promise.all([
      fs.writeFile(path.join(profileUser, 'registrymodifications.xcu'), profileConfig),
      fs.writeFile(input, bytes),
    ]);
    const filter = filters.get(ext);
    const options = filter === 'impress_pdf_Export' ? { ExportHiddenSlides: { type: 'boolean', value: 'true' } } : {};
    await convertToPdf(executable, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore',
      '--convert-to', `pdf:${filter}:${JSON.stringify(options)}`, '--outdir', temp, input,
    ], temp);
    const output = path.join(temp, 'document.pdf');
    const stat = await fs.stat(output);
    if (stat.size > limit) throw new Error('转换后的文档超过 64 MB');
    const data = await fs.readFile(output);
    if (data.subarray(0, 5).toString() !== '%PDF-') throw new Error('无法生成文档预览');
    return data;
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

async function readOfficePreview(bytes, ext, limit) {
  const executable = await officeExecutable();
  let reason = '当前环境缺少 Office 版式预览组件';
  if (executable && activeConversions < 2) {
    activeConversions += 1;
    try {
      const data = await renderOffice(executable, bytes, ext, limit);
      const sheet = filters.get(ext) === 'calc_pdf_Export' ? extractDocumentText(bytes, `document${ext}`) : null;
      return {
        kind: 'pdf', data, office: true,
        ...(sheet && { cellText: { content: sheet.text, truncated: sheet.truncated } }),
      };
    } catch {
      reason = '无法渲染此文档的版式';
    } finally {
      activeConversions -= 1;
    }
  } else if (executable) {
    reason = '文档预览忙，请重新选择该文件';
  }
  const extracted = extractDocumentText(bytes, `document${ext}`);
  if (extracted) return { kind: 'document', content: extracted.text, truncated: extracted.truncated, reason };
  throw new Error(executable ? `${reason}。请确认文档完整且无需密码。` : `${reason}，无法预览 ${ext.toUpperCase()} 文件。`);
}

module.exports = { isOfficeFormat, readOfficePreview };
