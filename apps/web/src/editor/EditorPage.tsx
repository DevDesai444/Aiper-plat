import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import * as Y from 'yjs'
import * as buffer from 'lib0/buffer'
import type { AiperRole, Document } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import { getDocument, getSnapshotState, postSave } from '../api/endpoints'
import { buildEditorExtensions } from './schema'
import { HistoryPanel } from './HistoryPanel'
import './editor.css'

/**
 * Document editor. Mounted at two routes — the folder-parented
 * `/p/:pid/f/:fid/d/:did` and the project-parented `/p/:pid/d/:did`
 * — because a document's parent is a data attribute (`Document.folderId`
 * vs `Document.projectId`) that does not change the editor's behaviour.
 *
 * PR-1 landed the read-only load path. PR-2 (this file, extended)
 * adds:
 *
 *   • Role-gated editing. `editor+` and `owner` are writable; `viewer`
 *     stays read-only and never sees the Save button. Role is fixed for
 *     the life of the mount — a grant change during the session means
 *     the user reloads (matches the WS handshake's own frozen-role
 *     policy on the server side).
 *
 *   • Explicit Save. Cmd/Ctrl-S + a titlebar button. Encodes the
 *     current Y.Doc state and POSTs it to `/documents/:did/save`; the
 *     server's returned `savedAt` drives the "Saved HH:MM" indicator so
 *     the clock is server-authoritative.
 *
 *   • Dirty tracking. Local ydoc updates (any origin other than
 *     `'hydrate'`, which the load path uses) flip the "unsaved" flag.
 *     A per-render stamp keeps edits that land during a save-in-flight
 *     from being silently cleared on the save's success.
 *
 * The Yjs WebSocket provider (real-time collab, remote cursors, auto-
 * save via the server's own tick) lands in PR-3, separately.
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

interface SaveState {
  savedAt: string | null
  saving: boolean
  dirty: boolean
  error: string | null
}

const INITIAL_SAVE: SaveState = { savedAt: null, saving: false, dirty: false, error: null }

/**
 * The two roles that gate the save flow. `owner` implies editor; the
 * server's `aiper_effective_access` collapses both to "writable" too.
 */
function canWrite(role: AiperRole | null | undefined): boolean {
  return role === 'editor' || role === 'owner'
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
  const [saveState, setSaveState] = useState<SaveState>(INITIAL_SAVE)

  // Destroy the Y.Doc on unmount. Kept separate from the load effect so
  // the load can rerun (StrictMode double-invoke, later refetches) without
  // stealing the ydoc's own cleanup.
  useEffect(() => () => ydoc.destroy(), [ydoc])

  useEffect(() => {
    const ac = new AbortController()
    setState({ status: 'loading', document: null, error: null })
    setSaveState(INITIAL_SAVE)
    ;(async () => {
      try {
        const doc = await getDocument(did, ac.signal)
        if (ac.signal.aborted) return
        if (doc.currentSnapshotId) {
          const bytes = await getSnapshotState(did, doc.currentSnapshotId, ac.signal)
          if (ac.signal.aborted) return
          // 'hydrate' origin lets the dirty-tracker below tell a load
          // apart from a real edit — mirrors the same string the server
          // uses when it hydrates a WS room's Y.Doc.
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
  //
  // We initialise `editable: false` and flip it once the load resolves
  // and we know the caller's role. TipTap's `setEditable` is a no-op
  // when the value doesn't change, so a re-render after role-change
  // has no cost.
  const editor = useEditor(
    {
      extensions,
      editable: false,
      editorProps: { attributes: { class: 'editor-page-content' } },
    },
    [],
  )

  const role = state.document?.myRole ?? null
  const editable = canWrite(role)
  useEffect(() => {
    if (editor) editor.setEditable(editable)
  }, [editor, editable])

  // Dirty tracker. `Y.Doc`'s update event fires for every applied
  // update — hydration, local edits, and (later) remote peer updates.
  // We skip the load-path's `'hydrate'` origin so opening a document
  // does not immediately mark it as unsaved.
  //
  // `dirtyStampRef` is a per-mount counter that lets `save()` tell
  // whether new edits landed during a save-in-flight — see save().
  const dirtyStampRef = useRef(0)
  useEffect(() => {
    const onUpdate = (_update: Uint8Array, origin: unknown): void => {
      if (origin === 'hydrate') return
      dirtyStampRef.current += 1
      setSaveState((prev) =>
        prev.dirty && prev.error === null
          ? prev
          : { ...prev, dirty: true, error: null },
      )
    }
    ydoc.on('update', onUpdate)
    return () => {
      ydoc.off('update', onUpdate)
    }
  }, [ydoc])

  // Guards a second concurrent save. `savingRef` is the single source of
  // truth for "am I already saving" — the state flag drives the UI, but
  // a ref lets `save()` early-return synchronously regardless of the
  // React render tick.
  const savingRef = useRef(false)
  const save = useCallback(async (): Promise<void> => {
    if (!editable) return
    if (savingRef.current) return
    savingRef.current = true
    // Snapshot the dirty counter BEFORE encoding: any update fired while
    // the POST is in flight will bump the counter past this value, so on
    // success we can leave the room marked dirty rather than clearing it
    // and losing the "please save again" signal.
    const stampAtSaveStart = dirtyStampRef.current
    setSaveState((prev) => ({ ...prev, saving: true, error: null }))
    try {
      const bytes = Y.encodeStateAsUpdate(ydoc)
      const yjsState = buffer.toBase64(bytes)
      const snap = await postSave(did, { yjsState })
      const stillDirty = dirtyStampRef.current > stampAtSaveStart
      setSaveState({
        savedAt: snap.savedAt,
        saving: false,
        dirty: stillDirty,
        error: null,
      })
    } catch (err: unknown) {
      setSaveState((prev) => ({
        ...prev,
        saving: false,
        error: describeError(err),
      }))
    } finally {
      savingRef.current = false
    }
  }, [editable, ydoc, did])

  // Kept in a ref so the window-level Cmd-S handler (registered once)
  // always calls the freshest closure — `save` re-creates whenever
  // `editable` / `did` change.
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        <SaveStatusPill save={saveState} editable={editable} />
        {editable && (
          <button
            type="button"
            className="editor-save-btn"
            onClick={() => void save()}
            disabled={saveState.saving}
            title="Save (Ctrl/⌘S)"
          >
            {saveState.saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </header>
      <div className="editor-scroll">
        <div className="editor-page">
          <EditorContent editor={editor} />
        </div>
      </div>
      <HistoryPanel documentId={did} />
    </div>
  )
}

/**
 * The tiny status line to the left of the Save button. `aria-live=polite`
 * so screen readers hear transitions ("Saving…" → "Saved 14:23") without
 * being interrupted.
 */
function SaveStatusPill({ save, editable }: { save: SaveState; editable: boolean }) {
  if (!editable) {
    return (
      <div className="editor-titlebar-status" aria-live="polite">
        Read-only
      </div>
    )
  }
  if (save.error) {
    return (
      <div
        className="editor-titlebar-status editor-titlebar-status--error"
        aria-live="polite"
      >
        Save failed — {save.error}
      </div>
    )
  }
  if (save.saving) {
    return (
      <div className="editor-titlebar-status" aria-live="polite">
        Saving…
      </div>
    )
  }
  if (save.dirty) {
    return (
      <div
        className="editor-titlebar-status editor-titlebar-status--dirty"
        aria-live="polite"
      >
        Unsaved changes
      </div>
    )
  }
  if (save.savedAt) {
    return (
      <div className="editor-titlebar-status" aria-live="polite">
        Saved {formatSavedAt(save.savedAt)}
      </div>
    )
  }
  return (
    <div className="editor-titlebar-status" aria-live="polite">
      Ready
    </div>
  )
}

/**
 * Render the server's ISO `savedAt` as HH:MM in the viewer's locale.
 * Kept intentionally simple — the Save timeline (E6) will render the
 * full history with dates; the titlebar just needs the "just saved"
 * hint.
 */
function formatSavedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
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
