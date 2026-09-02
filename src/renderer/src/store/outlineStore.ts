import { create } from 'zustand'

export interface OutlineHeading {
  id: string
  level: number
  text: string
  pos: number
}

interface OutlineState {
  headings: OutlineHeading[]
  activeHeadingId: string | null
  setHeadings: (headings: OutlineHeading[]) => void
  setActiveHeadingId: (id: string | null) => void
}

/** Populated live from the open document's heading nodes (see editor/useOutlineSync.ts),
 *  not static fixture data — the mockup's outline tree was hardcoded, this one is real. */
export const useOutlineStore = create<OutlineState>((set) => ({
  headings: [],
  activeHeadingId: null,
  setHeadings: (headings) => set({ headings }),
  setActiveHeadingId: (activeHeadingId) => set({ activeHeadingId })
}))
