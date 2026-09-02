import { create } from 'zustand'

/**
 * Backing store for the References ribbon tab. Footnotes, sources, captions, index entries
 * and bookmarks all live here rather than in the ProseMirror document: the document holds
 * only the visible marker text, so a reference survives being cut and re-pasted, and the
 * numbering can be recomputed in one place when entries are added or removed.
 */

export interface Footnote {
  id: string
  number: number
  text: string
}

export interface Source {
  id: string
  author: string
  title: string
  year: string
  detail: string
}

export interface Caption {
  id: string
  kind: 'Figure' | 'Table' | 'Equation'
  number: number
  text: string
}

export interface IndexEntry {
  id: string
  term: string
}

export interface Bookmark {
  id: string
  name: string
  /** Document position when the bookmark was set. Best-effort — edits above it shift the text. */
  pos: number
}

export const CITATION_STYLES = ['ICH / CTD', 'Vancouver', 'APA 7', 'Numbered'] as const
export type CitationStyle = (typeof CITATION_STYLES)[number]

interface ReferencesState {
  footnotes: Footnote[]
  sources: Source[]
  captions: Caption[]
  indexEntries: IndexEntry[]
  bookmarks: Bookmark[]
  citationStyle: CitationStyle

  addFootnote: (text: string) => Footnote
  removeFootnote: (id: string) => void
  addSource: (source: Omit<Source, 'id'>) => Source
  removeSource: (id: string) => void
  addCaption: (kind: Caption['kind'], text: string) => Caption
  addIndexEntry: (term: string) => IndexEntry
  addBookmark: (name: string, pos: number) => Bookmark
  cycleCitationStyle: () => CitationStyle
  clear: () => void
}

let seq = 0
const nextId = (prefix: string): string => `${prefix}-${++seq}`

/** Format a source the way the currently selected style would render it inline. */
export function formatCitation(source: Source, style: CitationStyle, index: number): string {
  switch (style) {
    case 'Vancouver':
      return `(${index})`
    case 'APA 7':
      return `(${source.author}, ${source.year})`
    case 'Numbered':
      return `[${index}]`
    default:
      return `(${source.author} ${source.year})`
  }
}

/** Full bibliography line for a source. */
export function formatBibliography(source: Source, style: CitationStyle, index: number): string {
  const base = `${source.author} (${source.year}). ${source.title}.${source.detail ? ` ${source.detail}` : ''}`
  return style === 'Vancouver' || style === 'Numbered' ? `${index}. ${base}` : base
}

export const useReferencesStore = create<ReferencesState>((set, get) => ({
  footnotes: [],
  sources: [],
  captions: [],
  indexEntries: [],
  bookmarks: [],
  citationStyle: 'ICH / CTD',

  addFootnote: (text) => {
    const note: Footnote = { id: nextId('fn'), number: get().footnotes.length + 1, text }
    set((s) => ({ footnotes: [...s.footnotes, note] }))
    return note
  },
  removeFootnote: (id) =>
    set((s) => ({
      footnotes: s.footnotes.filter((f) => f.id !== id).map((f, i) => ({ ...f, number: i + 1 }))
    })),

  addSource: (source) => {
    const entry: Source = { ...source, id: nextId('src') }
    set((s) => ({ sources: [...s.sources, entry] }))
    return entry
  },
  removeSource: (id) => set((s) => ({ sources: s.sources.filter((x) => x.id !== id) })),

  addCaption: (kind, text) => {
    const number = get().captions.filter((c) => c.kind === kind).length + 1
    const caption: Caption = { id: nextId('cap'), kind, number, text }
    set((s) => ({ captions: [...s.captions, caption] }))
    return caption
  },

  addIndexEntry: (term) => {
    const entry: IndexEntry = { id: nextId('idx'), term }
    set((s) => (s.indexEntries.some((e) => e.term === term) ? s : { indexEntries: [...s.indexEntries, entry] }))
    return entry
  },

  addBookmark: (name, pos) => {
    const mark: Bookmark = { id: nextId('bm'), name, pos }
    set((s) => ({ bookmarks: [...s.bookmarks.filter((b) => b.name !== name), mark] }))
    return mark
  },

  cycleCitationStyle: () => {
    const next = CITATION_STYLES[(CITATION_STYLES.indexOf(get().citationStyle) + 1) % CITATION_STYLES.length]
    set({ citationStyle: next })
    return next
  },

  clear: () => set({ footnotes: [], sources: [], captions: [], indexEntries: [], bookmarks: [] })
}))
