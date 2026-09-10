import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import * as Y from 'yjs'
import type { Document } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import { getDocument, getSnapshotState } from '../api/endpoints'
import { buildEditorExtensions } from './schema'
import './editor.css'

/**
 * Document editor. Mounted at two routes — the folder-parented
 * `/p/:pid/f/:fid/d/:did` and the project-parented `/p/:pid/d/:did`
 * — because a document's parent is a data attribute (`Document.folderId`
 * vs `Document.projectId`) that does not change the editor's behaviour.
 *
 * PR-1 scope: READ-ONLY. Loads `Document`, hydrates a fresh `Y.Doc` from
 * `currentSnapshotId`'s snapshot bytes when present, and mounts TipTap
 * with `editable: false`. Save + role-driven edit toggle land in PR-2;
 * the Yjs WebSocket provider (real-time collab + cursors) lands in PR-3.
 *
 * The Y.Doc's lifecycle is per-mount: creating one, hydrating from
 * bytes, and destroying it are cheap enough that we don't try to share
 * one across route transitions. `key={did}` on `<EditorPageInner/>`
 * forces a full remount when the user navigates between documents,
 * which is the cleanest way to keep hydration atomic — the previous
 * doc's bytes cannot leak into the new one's `Y.Doc`.
 */
export function EditorPage() {
  const { pid, fid, did } = useParams<{ pid?: string; fid?: string; did?: string }>()
  if (!did || !pid) {
    return <EditorFailCard title="Not found" detail="Missing route parameters." backTo="/" />
  }
  return <EditorPageInner key={did} did={did} pid={pid} fid={fid ?? null} />
}

interface LoadState {
  status: 'loading' | 'ready' | 'error'
  document: Document | null
  error: string | null
}

function EditorPageInner({ did, pid, fid }: { did: string; pid: string; fid: string | null }) {
  // A fresh Y.Doc per mount. `useState` (rather than `useMemo`) is the
  // React-idiomatic pattern for per-instance mutable state — StrictMode's
  // double-invoke reruns the initializer but discards the extra Y.Doc,
  // and the cleanup below tears down the one we kept.
  const [ydoc] = useState(() => new Y.Doc())
  const extensions = useMemo(() => buildEditorExtensions(ydoc), [ydoc])

  const [state, setState] = useState<LoadState>({
    status: 'loading',
    document: null,
    error: null,
  })

  // Destroy the Y.Doc on unmount. Kept separate from the load effect so
  // the load can rerun (StrictMode double-invoke, later refetches) without
  // stealing the ydoc's own cleanup.
  useEffect(() => () => ydoc.destroy(), [ydoc])

  useEffect(() => {
    const ac = new AbortController()
    setState({ status: 'loading', document: null, error: null })
    ;(async () => {
      try {
        const doc = await getDocument(did, ac.signal)
        if (ac.signal.aborted) return
        if (doc.currentSnapshotId) {
          const bytes = await getSnapshotState(did, doc.currentSnapshotId, ac.signal)
          if (ac.signal.aborted) return
          // 'hydrate' origin lets any future room-side or observer code
          // tell a load apart from a real edit — mirrors the same string
          // the server uses when it hydrates a WS room's Y.Doc.
          Y.applyUpdate(ydoc, bytes, 'hydrate')
        }
        if (ac.signal.aborted) return
        setState({ status: 'ready', document: doc, error: null })
      } catch (err: unknown) {
        if (ac.signal.aborted) return
        setState({ status: 'error', document: null, error: describeError(err) })
      }
    })()
    return () => ac.abort()
  }, [did, ydoc])

  // The editor is stable for the life of the mount — `key={did}` on the
  // parent guarantees a fresh instance when the user opens a different
  // document, so we never need `useEditor` to recreate the editor in
  // place. Explicit empty-deps make that intent unambiguous.
  const editor = useEditor(
    {
      extensions,
      editable: false,
      editorProps: { attributes: { class: 'editor-page-content' } },
    },
    [],
  )

  if (state.status === 'loading') {
    return <div className="page-loading">Loading document…</div>
  }
  if (state.status === 'error') {
    return (
      <EditorFailCard
        title="Could not open document"
        detail={state.error ?? undefined}
        backTo={fid ? `/p/${pid}/f/${fid}` : `/p/${pid}`}
      />
    )
  }

  const doc = state.document
  if (!doc) return null // exhausted by the status check above; keeps TS happy.

  return (
    <div className="editor-shell">
      <header className="editor-titlebar">
        <div className="editor-titlebar-crumbs">
          <Link to={fid ? `/p/${pid}/f/${fid}` : `/p/${pid}`}>← back</Link>
        </div>
        <h1 className="editor-titlebar-title">{doc.title}</h1>
        <div className="editor-titlebar-status" aria-live="polite">
          Read-only
        </div>
      </header>
      <div className="editor-scroll">
        <div className="editor-page">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}

function describeError(err: unknown): string {
  if (err instanceof ApiFetchError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return 'Failed to load document'
}

function EditorFailCard({
  title,
  detail,
  backTo,
}: {
  title: string
  detail?: string
  backTo: string
}) {
  return (
    <div className="editor-fail">
      <h1 className="editor-fail-title">{title}</h1>
      {detail && <p className="editor-fail-detail">{detail}</p>}
      <Link to={backTo}>← back</Link>
    </div>
  )
}
