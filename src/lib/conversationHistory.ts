import type { SessionCanvas, SessionMsg } from '../types';
export type HistoryEntry = { sessionId: string; label: string; archived: boolean; index: number; message: SessionMsg; text: string };
/** Build once per history revision, independently of the search query. No attachments or terminal blobs. */
export function buildHistoryIndex(sessions: Record<string, SessionCanvas>, order: string[], activeId: string | null, messages: SessionMsg[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const id of order) {
    const session = sessions[id];
    if (!session) continue;
    (id === activeId ? messages : session.messages || []).forEach((message, index) => {
      const paths = [...(message.editedFiles || []), ...(message.backendChanges?.files.map(file => file.path) || [])];
      entries.push({ sessionId: id, label: session.prompt || session.label, archived: !!session.archived, index, message,
        text: [session.label, session.prompt, message.content, message.run?.id, ...paths, ...(message.tools || []).map(tool => tool.name)].join('\n').toLocaleLowerCase() });
    });
  }
  return entries;
}
export function searchHistory(entries: HistoryEntry[], query: string, archived = false, pinned = false) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => (archived || !entry.archived) && (!pinned || entry.message.pinned) && terms.every(term => entry.text.includes(term)));
}
export function historyExcerpt(entry: HistoryEntry, query: string) {
  const text = entry.message.content || entry.message.run?.id || '工具执行记录';
  const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
  const match = term ? text.toLocaleLowerCase().indexOf(term) : 0;
  const start = Math.max(0, match - 35);
  return `${start ? '…' : ''}${text.slice(start, start + 150)}${text.length > start + 150 ? '…' : ''}`;
}
