import { create } from 'zustand';
export const useHistoryStore = create<{
  target: { sessionId: string; index: number; revision: number } | null;
  locate: (sessionId: string, index: number) => void;
}>((set) => ({ target: null, locate: (sessionId, index) => set(state => ({ target: { sessionId, index, revision: (state.target?.revision || 0) + 1 } })) }));
