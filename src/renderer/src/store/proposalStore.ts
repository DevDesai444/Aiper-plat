import { create } from 'zustand'
import { api, type Proposal } from '../api/client'

interface ProposalState {
  proposals: Proposal[]
  loading: boolean
  /** Number of open proposals on the currently-open document, for the dock tab badge. */
  openCount: number

  refresh: (documentId: string) => Promise<void>
  clear: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  proposals: [],
  loading: false,
  openCount: 0,

  refresh: async (documentId) => {
    set({ loading: true })
    try {
      const { proposals } = await api.listProposals(documentId)
      set({ proposals, loading: false, openCount: proposals.filter((p) => p.status === 'open').length })
    } catch {
      set({ loading: false })
    }
  },

  clear: () => set({ proposals: [], openCount: 0 })
}))
