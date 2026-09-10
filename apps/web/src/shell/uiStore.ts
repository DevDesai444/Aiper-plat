import { create } from 'zustand'

/**
 * The shell-chrome UI state — what's collapsed, what tab is active, what
 * text is in the navigator filter. Deliberately trimmed vs legacy: view
 * mode, page view, ruler/gridline toggles, markup mode and searchToken
 * are editor concerns and belong to E7's editor store when that ships.
 */

export type RibbonTabId =
  | 'Home'
  | 'Insert'
  | 'Layout'
  | 'References'
  | 'Review'
  | 'View'
  | 'Compatibility'

/** Right-rail Dock tabs. Content is empty in PR-1b; panels ship with the
 *  domain features that own them (E7 for AI chat + comments, E9 for the
 *  compatibility findings feed, E1's audit reader for the audit tab). */
export type DockTabId = 'chat' | 'compat' | 'comments' | 'audit'

interface UiState {
  ribbonOpen: boolean
  leftOpen: boolean
  dockOpen: boolean
  activeRibbonTab: RibbonTabId
  dockTab: DockTabId
  /** Live text filter for the Navigator tree. */
  navFilter: string

  toggleRibbon: () => void
  toggleLeft: () => void
  toggleDock: () => void
  setActiveRibbonTab: (tab: RibbonTabId) => void
  setDockTab: (tab: DockTabId) => void
  setNavFilter: (q: string) => void
}

export const useUiStore = create<UiState>((set) => ({
  ribbonOpen: true,
  leftOpen: true,
  dockOpen: true,
  activeRibbonTab: 'Home',
  dockTab: 'chat',
  navFilter: '',

  toggleRibbon: () => set((s) => ({ ribbonOpen: !s.ribbonOpen })),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setActiveRibbonTab: (activeRibbonTab) => set({ activeRibbonTab }),
  setDockTab: (dockTab) => set({ dockTab }),
  setNavFilter: (navFilter) => set({ navFilter }),
}))
