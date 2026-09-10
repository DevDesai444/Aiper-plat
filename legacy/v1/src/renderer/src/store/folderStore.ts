import { create } from 'zustand'
import { api } from '../api/client'
import { useToastStore } from '../common/toastStore'

export type Access = 'viewer' | 'editor' | 'owner'

export interface FolderDocument {
  id: string
  path: string
  title: string
  currentRevision: number
  updatedAt: string | null
  lockedBy: { userId: string; displayName: string } | null
}

export interface FolderFile {
  path: string
  name: string
  /** Blob sha — how the bytes are fetched when this file is sent for a compliance check. */
  sha: string
  /** An original .docx kept beside its editable projection, versus any other imported file. */
  kind: 'source' | 'other'
}

export interface FolderNode {
  id: string
  name: string
  parentId: string | null
  access: Access
  children: FolderNode[]
  documents: FolderDocument[]
  files: FolderFile[]
}

interface FolderState {
  folders: FolderNode[]
  expanded: Set<string>
  loading: boolean
  error: string | null
  /** Folder whose permissions dialog is open. */
  permissionsFor: { id: string; name: string } | null
  /** Folder the user last clicked — the target for folder-wide actions like a compliance run. */
  selectedFolder: { id: string; name: string } | null

  refresh: () => Promise<void>
  toggle: (id: string) => void
  createFolder: (name: string, parentId: string | null) => Promise<void>
  createDocument: (name: string, folderId: string) => Promise<void>
  selectFolder: (id: string, name: string) => void
  openPermissions: (id: string, name: string) => void
  closePermissions: () => void
  applyLockChange: (documentId: string, lockedBy: string | null, lockedByUserId: string | null) => void
  applyRevisionChange: (documentId: string, revision: number, savedAt: string) => void
}

function mapNodes(nodes: FolderNode[], fn: (n: FolderNode) => FolderNode): FolderNode[] {
  return nodes.map((n) => fn({ ...n, children: mapNodes(n.children, fn) }))
}

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  expanded: new Set(),
  loading: false,
  error: null,
  permissionsFor: null,
  selectedFolder: null,

  refresh: async () => {
    set({ loading: true })
    // The database is across the network, so a single failure is more likely to be a blip than
    // a real outage. Retry once before showing an error: latching "Internal Server Error" until
    // someone notices the Retry button makes a two-second hiccup look like a broken app.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { folders } = await api.listFolders()
        // Expand everything the first time so the structure is visible without hunting.
        const expanded = get().expanded.size === 0 ? collectIds(folders) : get().expanded
        set({ folders, loading: false, error: null, expanded })
        return
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 600))
          continue
        }
        set({ loading: false, error: err instanceof Error ? err.message : 'Could not load folders.' })
      }
    }
  },

  toggle: (id) =>
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expanded: next }
    }),

  createFolder: async (name, parentId) => {
    try {
      const { id } = await api.createFolder(name, parentId)
      useToastStore.getState().push(`Folder “${name}” created.`)
      await get().refresh()
      // Select the new folder and expand its parent: otherwise it is created somewhere
      // off-screen and the obvious next action ("now put a document in it") targets the
      // wrong place.
      set((s) => ({
        selectedFolder: { id, name },
        expanded: new Set([...s.expanded, id, ...(parentId ? [parentId] : [])])
      }))
    } catch (err) {
      useToastStore.getState().push(err instanceof Error ? err.message : 'Could not create folder.', 'error')
    }
  },

  createDocument: async (name, folderId) => {
    const path = name.endsWith('.docx') ? name : `${name}.docx`
    try {
      await api.createDocument(path, name.replace(/\.docx$/, ''), folderId)
      useToastStore.getState().push(`Document “${path}” created.`)
      await get().refresh()
    } catch (err) {
      useToastStore.getState().push(err instanceof Error ? err.message : 'Could not create document.', 'error')
    }
  },

  selectFolder: (id, name) => set({ selectedFolder: { id, name } }),
  openPermissions: (id, name) => set({ permissionsFor: { id, name } }),
  closePermissions: () => set({ permissionsFor: null }),

  applyLockChange: (documentId, lockedBy, lockedByUserId) =>
    set((s) => ({
      folders: mapNodes(s.folders, (n) => ({
        ...n,
        documents: n.documents.map((d) =>
          d.id === documentId
            ? { ...d, lockedBy: lockedByUserId ? { userId: lockedByUserId, displayName: lockedBy ?? 'Someone' } : null }
            : d
        )
      }))
    })),

  applyRevisionChange: (documentId, revision, savedAt) =>
    set((s) => ({
      folders: mapNodes(s.folders, (n) => ({
        ...n,
        documents: n.documents.map((d) => (d.id === documentId ? { ...d, currentRevision: revision, updatedAt: savedAt } : d))
      }))
    }))
}))

function collectIds(nodes: FolderNode[], acc = new Set<string>()): Set<string> {
  for (const n of nodes) {
    acc.add(n.id)
    collectIds(n.children, acc)
  }
  return acc
}
