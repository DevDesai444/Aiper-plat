/**
 * Read the live document out of whichever editor is mounted.
 *
 * The compliance panel needs the document as it stands right now, not as it was last written
 * to disk — findings that describe a stale file are worse than none, because a reviewer would
 * be clearing them against text they have already changed. But the panel is rendered in the
 * dock, outside the editor tree, so it has no editor to ask.
 *
 * Same shape as `editorCommandRegistry`: the mounted editor registers a provider, callers
 * look it up rather than importing the editor.
 */
import type { JSONContent } from '@tiptap/core'
import type { PageSetup } from '../store/documentStore'

export interface DocumentSnapshot {
  title: string
  content: JSONContent
  pageSetup: PageSetup
  header: JSONContent | null
  footer: JSONContent | null
}

let provider: (() => DocumentSnapshot) | null = null

export function registerDocumentSnapshotProvider(fn: () => DocumentSnapshot): () => void {
  provider = fn
  return () => {
    if (provider === fn) provider = null
  }
}

/** Null when no editor is mounted, so the caller can say why rather than sending nothing. */
export function getDocumentSnapshot(): DocumentSnapshot | null {
  return provider ? provider() : null
}
