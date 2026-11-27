import type { StageFile } from '../../lib/stageScene';
import './StageEvidence.css';

const changeLabels = { added: '新增', modified: '修改', deleted: '删除' };

export default function StageFileList({ files }: { files: StageFile[] }) {
  return <ul className="stage-evidence-files">{files.map(file => (
    <li key={file.path}><code>{file.path}</code><small>{file.reverted ? '已回滚' : changeLabels[file.kind]}</small></li>
  ))}</ul>;
}
