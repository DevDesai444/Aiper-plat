import { create } from 'zustand'
import { api } from '../api/client'
import { useDocumentStore } from './documentStore'

export interface CommentThread {
  id: string
  quotedText: string
  body: string
  authorName: string
  timestamp: string
  resolved: boolean
}

interface CommentState {
  comments: CommentThread[]
  /** Set by the editor so a comment can be removed from the document text too. */
  onDelete: ((id: string) => void) | null

  loadForDocument: (documentId: string) => Promise<void>
  addComment: (comment: CommentThread) => Promise<void>
  resolveComment: (id: string) => Promise<void>
  removeComment: (id: string) => Promise<void>
  clear: () => void
  registerDeleteHandler: (fn: (id: string) => void) => void
}

/**
 * Comments live on the server so they survive reopening a document — previously they were
 * in-memory only and were lost the moment the document was closed.
 * `id` here is the ProseMirror mark's commentId, which is what ties a thread to its text.
 */
export const useCommentStore = create<CommentState>((set, get) => ({
  comments: [],
  onDelete: null,

  loadForDocument: async (documentId) => {
    try {
      const { comments } = await api.listComments(documentId)
      set({
        comments: comments.map((c) => ({
          id: c.markId,
          quotedText: c.quotedText,
          body: c.body,
          authorName: c.authorName,
          timestamp: c.createdAt,
          resolved: c.resolvedAt !== null
        }))
      })
    } catch {
      set({ comments: [] })
    }
  },

  addComment: async (comment) => {
    set((s) => ({ comments: [...s.comments, comment] }))
    const documentId = useDocumentStore.getState().documentId
    if (documentId) {
      await api.addComment(documentId, comment.id, comment.quotedText, comment.body).catch(() => undefined)
    }
  },

  resolveComment: async (id) => {
    set((s) => ({ comments: s.comments.map((c) => (c.id === id ? { ...c, resolved: true } : c)) }))
    const documentId = useDocumentStore.getState().documentId
    if (documentId) await api.resolveComment(documentId, id).catch(() => undefined)
  },

  removeComment: async (id) => {
    get().onDelete?.(id)
    set((s) => ({ comments: s.comments.filter((c) => c.id !== id) }))
    const documentId = useDocumentStore.getState().documentId
    if (documentId) await api.deleteComment(documentId, id).catch(() => undefined)
  },

  clear: () => set({ comments: [] }),
  registerDeleteHandler: (fn) => set({ onDelete: fn })
}))
