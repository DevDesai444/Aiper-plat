import { create } from 'zustand'

export interface TrackedChange {
  id: string
  kind: 'insertion' | 'deletion'
  text: string
  authorName: string
  timestamp: string
  from: number
  to: number
}

interface TrackChangesState {
  changes: TrackedChange[]
  setChanges: (changes: TrackedChange[]) => void
  /** Wired to the live editor in editor/useTrackChangesSync.ts (Phase 4); until an editor
   *  is mounted these are no-ops rather than throwing, so the dock renders safely standalone. */
  acceptChange: (id: string) => void
  rejectChange: (id: string) => void
  onAccept: ((id: string) => void) | null
  onReject: ((id: string) => void) | null
  registerHandlers: (onAccept: (id: string) => void, onReject: (id: string) => void) => void
}

export const useTrackChangesStore = create<TrackChangesState>((set, get) => ({
  changes: [],
  onAccept: null,
  onReject: null,
  setChanges: (changes) => set({ changes }),
  acceptChange: (id) => get().onAccept?.(id),
  rejectChange: (id) => get().onReject?.(id),
  registerHandlers: (onAccept, onReject) => set({ onAccept, onReject })
}))
