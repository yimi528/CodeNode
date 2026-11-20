const fs = require('node:fs/promises');
const path = require('node:path');
const { isOfficeFormat, readOfficePreview } = require('./officePreview.cjs');

const MB = 1024 * 1024;
const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

function decodeText(bytes, truncated) {
  const bom = bytes.subarray(0, 3).toString('hex');
  const encodings = bom.startsWith('fffe') ? ['utf-16le']
    : bom.startsWith('feff') ? ['utf-16be']
    : bom.startsWith('efbbbf') ? ['utf-8'] : ['utf-8', 'gb18030'];

  for (const encoding of encodings) {
    try {
      const content = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
      if (!/[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(content)) {
        return { kind: 'text', content, encoding, truncated };
      }
    } catch {
      // Try the next encoding when the byte sequence is invalid.
    }
  }
  throw new Error('无法识别为受支持的文本编码或可预览的文件格式');
}

async function readFilePreview(root, relPath) {
  const realRoot = await fs.realpath(root);
  const fullPath = await fs.realpath(path.resolve(realRoot, relPath));
  const relative = path.relative(realRoot, fullPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('路径越界');
  }

  const ext = path.extname(relPath).toLowerCase();
  const mime = imageTypes[ext];
  const pdf = ext === '.pdf';
  const office = isOfficeFormat(ext);
  const limit = (pdf || office ? 64 : mime ? 16 : 1) * MB;
  const file = await fs.open(fullPath, 'r');
  let stat;
  let bytes;
  try {
    stat = await file.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件');
    if ((pdf || office || mime) && stat.size > limit) throw new Error(`文件过大，预览上限 ${limit / MB} MB`);
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    bytes = buffer.subarray(0, length);
  } finally {
    await file.close();
  }
  const preview = office ? await readOfficePreview(bytes, ext, limit)
    : pdf ? { kind: 'pdf', data: bytes }
    : mime ? { kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    : decodeText(bytes, stat.size > limit);
  return { ok: true, preview, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

module.exports = { imageTypes, readFilePreview };
