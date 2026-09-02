import { useCallback, useEffect } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { api, watchDocument, ApiError } from '../api/client'
import { useDocumentStore } from '../store/documentStore'
import { useServerDocsStore } from '../store/serverDocsStore'
import { useCommentStore } from '../store/commentStore'
import { useProposalStore } from '../store/proposalStore'
import { useToastStore } from '../common/toastStore'
import { askText } from '../common/promptStore'
import { useSessionStore } from '../store/sessionStore'

/** Renew the lock well inside the server's 90s lease so a slow network doesn't drop it. */

export function useServerDocument(editor: Editor | null): {
  saveToServer: () => Promise<void>
  reloadFromServer: () => Promise<void>
} {
  const documentId = useDocumentStore((s) => s.documentId)
  const pendingOpenServerDocId = useDocumentStore((s) => s.pendingOpenServerDocId)
  const clearPendingServerOpen = useDocumentStore((s) => s.clearPendingServerOpen)
  const openServerDocument = useDocumentStore((s) => s.openServerDocument)
  const setLockState = useDocumentStore((s) => s.setLockState)
  const markSaved = useDocumentStore((s) => s.markSaved)
  const clearPendingUpdate = useServerDocsStore((s) => s.clearPendingUpdate)

  const load = useCallback(
    async (id: string) => {
      if (!editor) return
      try {
        const { document } = await api.getDocument(id)
        editor.commands.setContent(document.content as JSONContent)
        const summary = useServerDocsStore.getState().documents.find((d) => d.id === id)
        openServerDocument({ documentId: id, revision: document.revision, title: summary?.path ?? document.documentId })

        // Try to check out. Read-only if someone else holds it — the editor stays usable for
        // reading, but saving will be refused server-side anyway.
        try {
          await api.lock(id)
          setLockState(true, null)
        } catch (err) {
          const holder = err instanceof ApiError ? (err.body as { lockedBy?: string } | null)?.lockedBy : undefined
          setLockState(false, holder ?? 'another user')
        }
        await useCommentStore.getState().loadForDocument(id)
        clearPendingUpdate()
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Could not open that document.')
      }
    },
    [editor, openServerDocument, setLockState, clearPendingUpdate]
  )

  useEffect(() => {
    if (pendingOpenServerDocId && editor) {
      const id = pendingOpenServerDocId
      clearPendingServerOpen()
      void load(id)
    }
  }, [pendingOpenServerDocId, editor, load, clearPendingServerOpen])

  // Tell the poller which document to watch, so other people's changes to the one on screen
  // are noticed first. There is no lock to hold: proposals replaced check-out locking.
  useEffect(() => {
    watchDocument(documentId ?? null)
    return () => watchDocument(null)
  }, [documentId])

  /**
   * Saving records a change PROPOSAL rather than writing the live document. Nobody blocks
   * anybody and nothing lands without a reviewer accepting it. Repeated saves update the
   * same proposal instead of raising a new one.
   */
  const saveToServer = useCallback(async () => {
    if (!editor || !documentId) return
    try {
      // Ask for a one-line summary only when opening a new proposal; later saves just update it.
      const myOpen = useProposalStore
        .getState()
        .proposals.find((p) => p.status === 'open' && p.authorId === useSessionStore.getState().user?.id)
      const summary = myOpen
        ? null
        : await askText('Briefly, what did you change?', '', {
            hint: 'Optional — it shows on your proposal so the reviewer knows what to look at.',
            confirmLabel: 'Save for review'
          })
      const res = await api.saveProposal(documentId, editor.getJSON(), summary)
      markSaved()
      await useProposalStore.getState().refresh(documentId)
      useToastStore
        .getState()
        .push(res.created ? 'Proposal raised for review.' : 'Your proposal was updated.')
    } catch (err) {
      useToastStore.getState().push(err instanceof Error ? err.message : 'Could not save.', 'error')
    }
  }, [editor, documentId, markSaved])

  const reloadFromServer = useCallback(async () => {
    if (documentId) await load(documentId)
  }, [documentId, load])

  return { saveToServer, reloadFromServer }
}
