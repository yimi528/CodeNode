'use strict';

const NAME = 'list_files';
const members = Object.freeze({ glob: 'find_files', dir: 'list_directory' });
const legacyNames = Object.freeze(Object.values(members));

/** One published schema. The action router dispatches to the original executor and contract. */
function descriptorFor(descriptors) {
  const kinds = Object.keys(members).filter(kind => descriptors.has(members[kind]));
  if (!kinds.length) return null;
  const glob = kinds.includes('glob');
  const dir = kinds.includes('dir');
  const description = [glob && 'glob：按通配符找文件。', dir && 'dir：列目录（默认）。', '跳过构建和缓存目录；用 offset 分页。'].filter(Boolean).join('');
  const outputSchemas = kinds.map(kind => descriptors.get(members[kind]).outputSchema);
  return {
    ...descriptors.get(members[kinds[0]]),
    name: NAME,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: kinds },
        ...(glob ? {
          pattern: { type: 'string', description: 'glob 必填，如 **/*.ts' },
          maxResults: { type: 'integer', description: 'glob 页大小，默认 100，最多 1000' },
        } : {}),
        ...(dir ? {
          path: { type: 'string', description: 'dir 相对目录，默认根目录' },
          recursive: { type: 'boolean', description: 'dir 递归，默认 false' },
        } : {}),
        offset: { type: 'integer', description: '分页起点，默认 0' },
      },
      required: dir ? [] : ['kind', 'pattern'],
      additionalProperties: false,
    },
    outputSchema: outputSchemas.length === 1 ? outputSchemas[0] : { anyOf: outputSchemas },
  };
}

module.exports = { NAME, members, legacyNames, descriptorFor };
