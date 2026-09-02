import { create } from 'zustand'
import type { JSONContent } from '@tiptap/core'

export interface PageSetup {
  size: 'A4' | 'Letter'
  orientation: 'portrait' | 'landscape'
  marginTopMm: number
  marginBottomMm: number
  marginLeftMm: number
  marginRightMm: number
  columns: number
}

export const DEFAULT_PAGE_SETUP: PageSetup = {
  size: 'A4',
  orientation: 'portrait',
  marginTopMm: 25.4,
  marginBottomMm: 25.4,
  marginLeftMm: 25.4,
  marginRightMm: 25.4,
  columns: 1
}

export interface DocumentTheme {
  name: string
  bodyFont: string
  headingFont: string
  accent: string
}

export const THEMES: Record<'aiperCtd' | 'ectdPlain', DocumentTheme> = {
  aiperCtd: { name: 'Aiper CTD', bodyFont: 'Times New Roman', headingFont: 'Barlow Semi Condensed', accent: '#749dc4' },
  ectdPlain: { name: 'eCTD plain', bodyFont: 'Arial', headingFont: 'Arial', accent: '#555555' }
}

export const ACCENT_PALETTES = ['#749dc4', '#c98b6b', '#6b9c7a', '#8b7bb8', '#b8836b']
export const PARAGRAPH_SPACINGS = [0, 6, 12, 18]

interface DocumentState {
  filePath: string | null
  fileName: string | null
  dirty: boolean
  savedAt: string | null
  pageSetup: PageSetup
  trackChangesEnabled: boolean
  zoom: number
  /** Design tab — presentation only, not part of the docx model. */
  theme: DocumentTheme
  accent: string
  paragraphSpacingPt: number
  shadowEffects: boolean
  watermark: string
  pageColor: string | null
  pageBorders: boolean
  lineNumbers: boolean
  /** Review → Restrict editing. Makes the editor read-only without a server lock. */
  restrictEditing: boolean
  spellcheck: boolean
  language: string
  pendingOpenPath: string | null
  /** Server document requested from the tree; EditorCanvas loads it. */
  pendingOpenServerDocId: string | null
  /** Server-side identity. Null for a purely local, unsaved document. */
  documentId: string | null
  /** Revision this editor was loaded from — the base for the next save. */
  revision: number
  lockedByMe: boolean
  lockedByOther: string | null
  headerText: string
  footerText: string
  /** Bumped whenever a blank document is started. EditorCanvas watches it and clears the
   *  editor — without this, `File → New` keeps the previous document's body, because
   *  setContent is otherwise only called on the open-from-disk path. */
  resetToken: number

  openDocument: (filePath: string, fileName: string, pageSetup?: PageSetup) => void
  newDocument: (fileName: string) => void
  markDirty: () => void
  markSaved: () => void
  setPageSetup: (pageSetup: PageSetup) => void
  toggleTrackChanges: () => void
  setZoom: (zoom: number) => void
  requestOpen: (path: string) => void
  clearPendingOpen: () => void
  requestOpenServerDoc: (id: string) => void
  clearPendingServerOpen: () => void
  openServerDocument: (args: { documentId: string; revision: number; title: string }) => void
  setRevision: (revision: number) => void
  setLockState: (lockedByMe: boolean, lockedByOther: string | null) => void
  setHeaderText: (text: string) => void
  setFooterText: (text: string) => void
  cycleOrientation: () => void
  cycleMargins: () => void
  setTheme: (key: keyof typeof THEMES) => DocumentTheme
  cycleAccent: () => string
  cycleParagraphSpacing: () => number
  toggleShadowEffects: () => boolean
  setWatermark: (text: string) => void
  setPageColor: (color: string | null) => void
  togglePageBorders: () => boolean
  toggleLineNumbers: () => boolean
  toggleRestrictEditing: () => boolean
  toggleSpellcheck: () => boolean
  setLanguage: (language: string) => void
  cycleColumns: () => number
  setColumns: (columns: number) => void
}

const MARGIN_PRESETS: Array<{ name: string; mm: number }> = [
  { name: 'Normal', mm: 25.4 },
  { name: 'Narrow', mm: 12.7 },
  { name: 'Wide', mm: 38.1 }
]

function formatSavedTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  filePath: null,
  fileName: null,
  dirty: false,
  savedAt: null,
  pageSetup: DEFAULT_PAGE_SETUP,
  trackChangesEnabled: false,
  zoom: 100,
  theme: THEMES.aiperCtd,
  accent: ACCENT_PALETTES[0],
  paragraphSpacingPt: 6,
  shadowEffects: false,
  watermark: '',
  pageColor: null,
  pageBorders: false,
  lineNumbers: false,
  restrictEditing: false,
  spellcheck: true,
  language: 'English (US)',
  pendingOpenPath: null,
  pendingOpenServerDocId: null,
  documentId: null,
  revision: 0,
  lockedByMe: false,
  lockedByOther: null,
  headerText: '',
  footerText: '',
  resetToken: 0,

  openDocument: (filePath, fileName, pageSetup) =>
    set({ filePath, fileName, dirty: false, savedAt: formatSavedTime(new Date()), pageSetup: pageSetup ?? DEFAULT_PAGE_SETUP }),
  newDocument: (fileName) =>
    set((s) => ({
      filePath: null,
      fileName,
      dirty: false,
      savedAt: null,
      pageSetup: DEFAULT_PAGE_SETUP,
      // Header/footer are per-document; leaving them set would write the previous
      // document's running head into the new file.
      headerText: '',
      footerText: '',
      resetToken: s.resetToken + 1
    })),
  markDirty: () => set({ dirty: true }),
  markSaved: () => set({ dirty: false, savedAt: formatSavedTime(new Date()) }),
  setPageSetup: (pageSetup) => set({ pageSetup, dirty: true }),
  toggleTrackChanges: () => set((s) => ({ trackChangesEnabled: !s.trackChangesEnabled })),
  setZoom: (zoom) => set({ zoom }),
  requestOpen: (path) => set({ pendingOpenPath: path }),
  clearPendingOpen: () => set({ pendingOpenPath: null }),
  requestOpenServerDoc: (id) => set({ pendingOpenServerDocId: id }),
  clearPendingServerOpen: () => set({ pendingOpenServerDocId: null }),
  openServerDocument: ({ documentId, revision, title }) =>
    set({
      documentId,
      revision,
      fileName: title,
      filePath: null,
      dirty: false,
      savedAt: formatSavedTime(new Date()),
      lockedByMe: false,
      lockedByOther: null
    }),
  setRevision: (revision) => set({ revision }),
  setLockState: (lockedByMe, lockedByOther) => set({ lockedByMe, lockedByOther }),
  setHeaderText: (headerText) => set({ headerText, dirty: true }),
  setFooterText: (footerText) => set({ footerText, dirty: true }),
  cycleOrientation: () =>
    set((s) => ({
      pageSetup: {
        ...s.pageSetup,
        orientation: s.pageSetup.orientation === 'portrait' ? 'landscape' : 'portrait'
      },
      dirty: true
    })),
  cycleMargins: () =>
    set((s) => {
      const idx = MARGIN_PRESETS.findIndex((p) => p.mm === s.pageSetup.marginTopMm)
      const next = MARGIN_PRESETS[(idx + 1) % MARGIN_PRESETS.length]
      return {
        pageSetup: {
          ...s.pageSetup,
          marginTopMm: next.mm,
          marginBottomMm: next.mm,
          marginLeftMm: next.mm,
          marginRightMm: next.mm
        },
        dirty: true
      }
    }),

  setTheme: (key) => {
    const theme = THEMES[key]
    set({ theme, accent: theme.accent, dirty: true })
    return theme
  },
  cycleAccent: () => {
    const accent = ACCENT_PALETTES[(ACCENT_PALETTES.indexOf(get().accent) + 1) % ACCENT_PALETTES.length]
    set({ accent, dirty: true })
    return accent
  },
  cycleParagraphSpacing: () => {
    const next = PARAGRAPH_SPACINGS[(PARAGRAPH_SPACINGS.indexOf(get().paragraphSpacingPt) + 1) % PARAGRAPH_SPACINGS.length]
    set({ paragraphSpacingPt: next, dirty: true })
    return next
  },
  toggleShadowEffects: () => {
    const shadowEffects = !get().shadowEffects
    set({ shadowEffects })
    return shadowEffects
  },
  setWatermark: (watermark) => set({ watermark, dirty: true }),
  setPageColor: (pageColor) => set({ pageColor, dirty: true }),
  togglePageBorders: () => {
    const pageBorders = !get().pageBorders
    set({ pageBorders, dirty: true })
    return pageBorders
  },
  toggleLineNumbers: () => {
    const lineNumbers = !get().lineNumbers
    set({ lineNumbers })
    return lineNumbers
  },
  toggleRestrictEditing: () => {
    const restrictEditing = !get().restrictEditing
    set({ restrictEditing })
    return restrictEditing
  },
  toggleSpellcheck: () => {
    const spellcheck = !get().spellcheck
    set({ spellcheck })
    return spellcheck
  },
  setLanguage: (language) => set({ language }),
  cycleColumns: () => {
    const columns = (get().pageSetup.columns % 3) + 1
    set((s) => ({ pageSetup: { ...s.pageSetup, columns }, dirty: true }))
    return columns
  },
  setColumns: (columns) => set((s) => ({ pageSetup: { ...s.pageSetup, columns }, dirty: true }))
}))

export type { JSONContent }
