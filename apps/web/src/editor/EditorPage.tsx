import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import * as buffer from 'lib0/buffer'
import type { AiperRole, Document } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import { supabase } from '../auth/supabase'
import { useSessionStore } from '../auth/sessionStore'
import {
  createComment,
  getDocument,
  getSnapshotState,
  postSave,
} from '../api/endpoints'
import { buildEditorExtensions } from './schema'
import {
  AiperCollabProvider,
  collabCursorColorForUser,
  type CollabStatus,
} from './collabProvider'
import { HistoryPanel } from './HistoryPanel'
import { CommentsPanel, type ComposePrompt } from './CommentsPanel'
import './editor.css'

/**
 * Document editor. Mounted at two routes — the folder-parented
 * `/p/:pid/f/:fid/d/:did` and the project-parented `/p/:pid/d/:did`
 * — because a document's parent is a data attribute (`Document.folderId`
 * vs `Document.projectId`) that does not change the editor's behaviour.
 *
 * PR-1 landed the read-only load path.
 * PR-2 added role-gated editing, Cmd/Ctrl-S + Save button + saved
 *      indicator, and a dirty tracker that keeps edits landing during
 *      a save-in-flight from being silently cleared on success.
 * PR-3 (this file, extended) wires the Yjs WebSocket provider:
 *
 *   • Live sync. After the initial HTTP load resolves, an
 *     `AiperCollabProvider` connects to `/ws?token=<jwt>&doc=<did>`
 *     and starts relaying doc + awareness updates between this
 *     client and the server room. Remote edits from peers apply
 *     into the same Y.Doc TipTap is bound to, so the ProseMirror
 *     document updates without any additional plumbing.
 *
 *   • Remote cursors. `@tiptap/extension-collaboration-cursor` reads
 *     from the same Awareness the provider broadcasts on, so peers'
 *     cursors + names paint as decorations in this editor.
 *
 *   • Editable vs viewer. Every role connects (viewers see live
 *     edits and cursors), but only editor+ actually broadcasts doc
 *     updates — the server also drops viewer writes silently, but we
 *     don't bother sending them.
 *
 *   • Manual Save coexists. The WS server auto-snapshots the room
 *     every ~30 s (durability), so real-time edits are safe even
 *     without manual saves. Cmd/Ctrl-S stays as an explicit
 *     "checkpoint" that flows `reason` into audit_log — durability
 *     vs intent split, matching the server's SnapshotReason policy.
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
  // Fresh Y.Doc + Awareness per mount. `useState`'s initializer runs
  // once per mount even under StrictMode double-invoke (the extra
  // instance is discarded), so a single combined initializer keeps the
  // two objects paired for their whole lifetime.
  const [{ ydoc, awareness }] = useState(() => {
    const d = new Y.Doc()
    return { ydoc: d, awareness: new Awareness(d) }
  })

  // Cursor identity captured once at mount from the session store. Uses
  // `.getState()` rather than the subscription form because per-user
  // display info is stable while the editor is mounted — resubscribing
  // per render would re-invalidate extensions and remount the editor.
  const [cursorUser] = useState<{ name: string; color: string } | null>(() => {
    const u = useSessionStore.getState().user
    if (!u) return null
    return { name: u.displayName, color: collabCursorColorForUser(u.id) }
  })

  const extensions = useMemo(
    () =>
      buildEditorExtensions({
        ydoc,
        cursor: cursorUser ? { awareness, user: cursorUser } : undefined,
      }),
    [ydoc, awareness, cursorUser],
  )

  const [state, setState] = useState<LoadState>({
    status: 'loading',
    document: null,
    error: null,
  })
  const [saveState, setSaveState] = useState<SaveState>(INITIAL_SAVE)

  // 'off' — provider not spawned yet (or torn down). Provider callbacks
  // move this through connecting → connected → disconnected / terminal.
  const [collabStatus, setCollabStatus] = useState<CollabStatus | 'off'>('off')

  // PR-4 compose state — non-null while the user has hit "Comment" and is
  // typing the body. `from`/`to` are captured at click time so a wandering
  // selection while typing does not move where the mark lands.
  interface PendingCompose extends ComposePrompt { from: number; to: number }
  const [compose, setCompose] = useState<PendingCompose | null>(null)

  // Destroy the Y.Doc + Awareness on unmount. Kept separate from the
  // load effect so the load can rerun (StrictMode double-invoke, later
  // refetches) without stealing this cleanup. Awareness is destroyed
  // before the Y.Doc so its `beforeunload` cleanup finds an intact doc.
  useEffect(() => {
    return () => {
      awareness.destroy()
      ydoc.destroy()
    }
  }, [ydoc, awareness])

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

  // PR-4 comment flow ---------------------------------------------------------
  //
  // Start: capture the current selection range + quoted text, generate a
  // fresh markId, and hand it to CommentsPanel via `compose`. The panel
  // opens itself and renders a compose form. Mark is NOT applied yet —
  // that happens on submit, in the order (POST first, then mark) so a
  // failed POST does not leave an orphan highlight peers can click on.
  const startComment = useCallback((): void => {
    if (!editor || !editable) return
    const { from, to } = editor.state.selection
    if (from === to) return // no selection, nothing to anchor to
    const quotedText = editor.state.doc.textBetween(from, to, '\n', ' ').trim()
    setCompose({
      markId: crypto.randomUUID(),
      quotedText: quotedText.slice(0, 4000), // matches server's quotedText cap
      from,
      to,
    })
  }, [editor, editable])

  const submitCompose = useCallback(
    async (body: string): Promise<void> => {
      if (!editor || !compose) return
      // POST first — a failed create must not leave an orphan mark in
      // the shared Y.Doc, which every peer would see as a highlight
      // without a thread. Only after a successful POST do we apply the
      // mark to the captured range.
      await createComment(did, {
        markId: compose.markId,
        quotedText: compose.quotedText,
        body,
      })
      editor
        .chain()
        .focus()
        .setTextSelection({ from: compose.from, to: compose.to })
        .setMark('comment', { markId: compose.markId })
        .run()
      setCompose(null)
    },
    [editor, compose, did],
  )

  const cancelCompose = useCallback((): void => {
    setCompose(null)
  }, [])

  // After the panel deletes a thread on the server, strip the mark
  // from the local Y.Doc so peers stop seeing the orphan highlight.
  // (Peers eventually observe this via CRDT sync.)
  const stripCommentMark = useCallback(
    (markId: string): void => {
      if (!editor) return
      removeCommentMarkFromEditor(editor, markId)
    },
    [editor],
  )

  // Yjs WebSocket provider — spawns after the initial HTTP load resolves
  // so hydrated bytes are already in the Y.Doc; the provider's own
  // SyncStep1 then only asks the server for what is truly missing.
  //
  // We skip provider spawn when there is no signed-in user, since we
  // have no cursor identity and no token to authenticate with. In prod
  // `RequireSession` guarantees a user by the time this route mounts,
  // so this branch mostly matters for unit tests.
  useEffect(() => {
    if (state.status !== 'ready' || !state.document) return
    if (!cursorUser) return
    const editable = canWrite(state.document.myRole)
    setCollabStatus('connecting')
    const provider = new AiperCollabProvider({
      ydoc,
      awareness,
      documentId: did,
      editable,
      getToken: async () => {
        const { data } = await supabase.auth.getSession()
        return data.session?.access_token ?? null
      },
      onStatus: setCollabStatus,
      // onError is intentionally silent — status drives the UI dot;
      // console logging is a later concern once we have a debug channel.
    })
    return () => {
      provider.destroy()
      setCollabStatus('off')
    }
  }, [state.status, state.document?.myRole, did, ydoc, awareness, cursorUser])

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
        <CollabStatusDot status={collabStatus} />
        <SaveStatusPill save={saveState} editable={editable} />
        {editable && (
          <button
            type="button"
            className="editor-titlebar-btn"
            onClick={startComment}
            title="Comment on the current selection"
          >
            Comment
          </button>
        )}
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
      <CommentsPanel
        documentId={did}
        ydoc={ydoc}
        role={role}
        compose={compose}
        onSubmitCompose={submitCompose}
        onCancelCompose={cancelCompose}
        onAfterDelete={stripCommentMark}
      />
    </div>
  )
}

/**
 * Strip every occurrence of the `comment` mark with `markId === target`
 * from the editor's ProseMirror document. Called after a successful
 * DELETE /comments/:markId so the shared Y.Doc loses the orphan
 * highlight the same tick the thread disappears. Peers observe the
 * mark removal via CRDT sync on their side.
 */
function removeCommentMarkFromEditor(editor: Editor, target: string): void {
  const markType = editor.schema.marks['comment']
  if (!markType) return
  const tr = editor.state.tr
  let modified = false
  editor.state.doc.descendants((node, pos) => {
    if (node.marks.length === 0) return
    for (const m of node.marks) {
      if (m.type === markType && m.attrs['markId'] === target) {
        tr.removeMark(pos, pos + node.nodeSize, markType)
        modified = true
      }
    }
  })
  if (modified) editor.view.dispatch(tr)
}

/**
 * Small dot showing the WS provider's connection status. Rendered only
 * once the provider has spawned; hidden while the initial load is in
 * flight (`status === 'off'`) so users don't see a red dot before we
 * even try to connect.
 */
function CollabStatusDot({ status }: { status: CollabStatus | 'off' }) {
  if (status === 'off') return null
  const labels: Record<CollabStatus, string> = {
    connecting: 'Connecting to live sync…',
    connected: 'Live sync connected',
    disconnected: 'Reconnecting to live sync…',
    terminal: 'Live sync offline',
  }
  return (
    <span
      className={`editor-collab-dot editor-collab-dot--${status}`}
      title={labels[status]}
      aria-label={labels[status]}
      role="status"
    />
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
