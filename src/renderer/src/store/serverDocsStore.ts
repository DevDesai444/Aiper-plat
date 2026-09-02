import { create } from 'zustand'
import { api, type ApiDocument, type ServerEvent } from '../api/client'
import { useSessionStore } from './sessionStore'

/** A save by someone else, waiting for the current user to pull it in. */
export interface PendingUpdate {
  documentId: string
  revision: number
  savedBy: string
  savedAt: string
}

interface ServerDocsState {
  documents: ApiDocument[]
  loading: boolean
  error: string | null
  /** Set when another user saves the document we currently have open. */
  pendingUpdate: PendingUpdate | null

  refresh: () => Promise<void>
  handleServerEvent: (e: ServerEvent) => void
  clearPendingUpdate: () => void
}

export const useServerDocsStore = create<ServerDocsState>((set, get) => ({
  documents: [],
  loading: false,
  error: null,
  pendingUpdate: null,

  refresh: async () => {
    set({ loading: true })
    try {
      const { documents } = await api.listDocuments()
      set({ documents, loading: false, error: null })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Could not load documents.' })
    }
  },

  handleServerEvent: (e) => {
    switch (e.event) {
      case 'document:updated': {
        // Reflect the new revision in the tree for everyone.
        set({
          documents: get().documents.map((d) =>
            d.id === e.payload.documentId
              ? { ...d, currentRevision: e.payload.revision, updatedAt: e.payload.savedAt }
              : d
          )
        })
        // Only prompt the people who did NOT make the save, and only for the open document.
        const selfId = useSessionStore.getState().user?.id
        if (e.payload.savedByUserId !== selfId) {
          set({
            pendingUpdate: {
              documentId: e.payload.documentId,
              revision: e.payload.revision,
              savedBy: e.payload.savedBy,
              savedAt: e.payload.savedAt
            }
          })
        }
        return
      }
      case 'lock:changed': {
        set({
          documents: get().documents.map((d) =>
            d.id === e.payload.documentId
              ? {
                  ...d,
                  lockedBy: e.payload.lockedByUserId
                    ? {
                        userId: e.payload.lockedByUserId,
                        displayName: e.payload.lockedBy ?? 'Someone',
                        expiresAt: ''
                      }
                    : null
                }
              : d
          )
        })
        return
      }
      case 'documents:changed':
        void get().refresh()
        return
      default:
        return
    }
  },

  clearPendingUpdate: () => set({ pendingUpdate: null })
}))
