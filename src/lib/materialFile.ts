import { fileToAttachment, inferredTextMime, MAX_TEXT_FILE_BYTES } from './imageAttach';

export async function readMaterial(file: File) {
  if (file.type.startsWith('image/')) {
    const result = await fileToAttachment(file);
    if (!result.ok) throw new Error(result.error);
    return { type: 'image', data: { label: file.name, imagePath: '', dataUrl: result.attachment.dataUrl } };
  }
  if (!inferredTextMime(file)) throw new Error('此格式请通过项目文件路径引用');
  if (file.size > MAX_TEXT_FILE_BYTES) throw new Error('文本资料上限为 2 MB');
  const content = await file.text();
  if (content.includes('\0')) throw new Error('此文件包含二进制内容，请通过项目文件路径引用');
  return { type: 'file', data: { label: file.name, filePath: '', content } };
}
