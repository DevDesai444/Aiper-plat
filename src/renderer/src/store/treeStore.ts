import { create } from 'zustand'

export interface FsTreeNode {
  path: string
  name: string
  type: 'folder' | 'docx' | 'file'
  children?: FsTreeNode[]
}

interface TreeState {
  rootPath: string | null
  root: FsTreeNode | null
  openFolders: Set<string>
  loading: boolean

  openRoot: (rootPath: string) => Promise<void>
  refresh: () => Promise<void>
  toggleFolder: (path: string) => void
}

export const useTreeStore = create<TreeState>((set, get) => ({
  rootPath: null,
  root: null,
  openFolders: new Set(),
  loading: false,

  openRoot: async (rootPath) => {
    if (!window.aiper) return
    set({ loading: true, rootPath })
    const root = await window.aiper.fs.readDirRecursive(rootPath)
    set({ root, loading: false, openFolders: new Set([rootPath]) })
  },

  refresh: async () => {
    const { rootPath } = get()
    if (!rootPath || !window.aiper) return
    const root = await window.aiper.fs.readDirRecursive(rootPath)
    set({ root })
  },

  toggleFolder: (path) =>
    set((s) => {
      const next = new Set(s.openFolders)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { openFolders: next }
    })
}))
