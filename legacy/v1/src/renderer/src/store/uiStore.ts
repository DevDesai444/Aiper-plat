import { create } from 'zustand'

export type ViewMode = 'welcome' | 'editor' | 'folder' | 'settings' | 'file'

/** A project file being viewed in the centre — a PDF, an image, anything not editable. */
export interface PreviewFile {
  projectFullName: string
  path: string
  name: string
  sha: string
}
export type DockTab = 'chat' | 'compliance' | 'comments' | 'audit' | 'proposals'
export type TreeTab = 'project' | 'outline'
/** How the page itself is drawn. Separate from `view`, which picks the whole centre pane. */
export type PageView = 'print' | 'read' | 'web' | 'draft'
/** Word's three tracked-change display levels. */
export type MarkupMode = 'all' | 'simple' | 'none'
export type RibbonTabId =
  | 'File'
  | 'Home'
  | 'Insert'
  | 'Design'
  | 'Layout'
  | 'References'
  | 'Mailings'
  | 'Review'
  | 'View'
  | 'Compliance'

interface UiState {
  ribbonOpen: boolean
  leftOpen: boolean
  dockOpen: boolean
  view: ViewMode
  previewFile: PreviewFile | null
  dock: DockTab
  treeTab: TreeTab
  activeRibbonTab: RibbonTabId
  activeFindingId: string | null
  selectedTreePath: string | null
  pageView: PageView
  showRuler: boolean
  showGridlines: boolean
  markupMode: MarkupMode
  /** Live text filter for the navigator tree. */
  navFilter: string
  /** Set by the title bar's Search button; EditorCanvas opens its find bar on a bump. */
  searchToken: number

  toggleRibbon: () => void
  toggleLeft: () => void
  toggleDock: () => void
  setView: (view: ViewMode) => void
  /** Show a project file in the centre pane. */
  openPreview: (file: PreviewFile) => void
  setDock: (dock: DockTab, opts?: { open?: boolean }) => void
  setTreeTab: (tab: TreeTab) => void
  setActiveRibbonTab: (tab: RibbonTabId) => void
  setActiveFinding: (id: string | null) => void
  setSelectedTreePath: (path: string | null) => void
  setPageView: (view: PageView) => void
  toggleRuler: () => void
  toggleGridlines: () => void
  setMarkupMode: (mode: MarkupMode) => void
  cycleMarkupMode: () => MarkupMode
  setNavFilter: (q: string) => void
  requestSearch: () => void
}

const MARKUP_ORDER: MarkupMode[] = ['all', 'simple', 'none']

export const useUiStore = create<UiState>((set, get) => ({
  ribbonOpen: true,
  leftOpen: true,
  dockOpen: true,
  view: 'welcome',
  previewFile: null,
  dock: 'chat',
  treeTab: 'project',
  activeRibbonTab: 'Home',
  activeFindingId: null,
  selectedTreePath: null,
  pageView: 'print',
  showRuler: false,
  showGridlines: false,
  markupMode: 'all',
  navFilter: '',
  searchToken: 0,

  toggleRibbon: () => set((s) => ({ ribbonOpen: !s.ribbonOpen })),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setView: (view) => set({ view }),
  openPreview: (file) => set({ previewFile: file, view: 'file' }),
  setDock: (dock, opts) => set({ dock, ...(opts?.open ? { dockOpen: true } : {}) }),
  setTreeTab: (treeTab) => set({ treeTab }),
  setActiveRibbonTab: (activeRibbonTab) => set({ activeRibbonTab }),
  setActiveFinding: (activeFindingId) => set({ activeFindingId }),
  setSelectedTreePath: (selectedTreePath) => set({ selectedTreePath }),
  setPageView: (pageView) => set({ pageView }),
  toggleRuler: () => set((s) => ({ showRuler: !s.showRuler })),
  toggleGridlines: () => set((s) => ({ showGridlines: !s.showGridlines })),
  setMarkupMode: (markupMode) => set({ markupMode }),
  cycleMarkupMode: () => {
    const next = MARKUP_ORDER[(MARKUP_ORDER.indexOf(get().markupMode) + 1) % MARKUP_ORDER.length]
    set({ markupMode: next })
    return next
  },
  setNavFilter: (navFilter) => set({ navFilter }),
  requestSearch: () => set((s) => ({ searchToken: s.searchToken + 1 }))
}))
