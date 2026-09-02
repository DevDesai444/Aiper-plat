import { create } from 'zustand'

interface EditorStatsState {
  wordCount: number
  charCount: number
  page: number
  totalPages: number
  setStats: (stats: Partial<Omit<EditorStatsState, 'setStats'>>) => void
}

/** Updated live from the editor on every transaction (see editor/useEditorStats.ts).
 *  Page/totalPages are an estimate (content height / page height), not true pagination —
 *  see the plan's pagination notes for why. */
export const useEditorStatsStore = create<EditorStatsState>((set) => ({
  wordCount: 0,
  charCount: 0,
  page: 1,
  totalPages: 1,
  setStats: (stats) => set(stats)
}))
