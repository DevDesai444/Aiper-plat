import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle, X, Check, Trash2 } from 'lucide-react'
import * as Y from 'yjs'
import type { AiperRole, Comment } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import {
  deleteCommentThread,
  listDocumentComments,
  resolveCommentThread,
} from '../api/endpoints'
import { useSessionStore } from '../auth/sessionStore'
import './comments.css'

/**
 * Comments drawer + FAB, like HistoryPanel — a self-contained overlay
 * so the host (EditorPage) does not have to reserve layout space when
 * it is closed.
 *
 * Split of concerns
 *   The mark (highlight) lives in the shared Y.Doc and syncs to peers
 *   CRDT-native. The bodies live over REST on the server, keyed by
 *   `(documentId, markId)`. This component fetches the bodies and
 *   renders per-`markId` threads; the highlight itself is painted by
 *   TipTap via `CommentMark`.
 *
 * Live refresh
 *   Three signals refetch the list, deduped by React state:
 *     • Local mutations (add / resolve / delete) — the parent hands
 *       us `composeInFlight` results and the local mutation buttons
 *       do their own refetch.
 *     • Y.Doc observer — when the set of `markId`s in the shared doc
 *       changes (a peer added / deleted a mark), we refetch after a
 *       short debounce. Only fires on set-change, so typing does not
 *       trigger a fetch storm.
 *     • Opening the drawer — first-open on a session always fetches.
 *
 * Role rules (mirror the server contract)
 *   viewer  — reads threads; sees no compose, resolve, or delete UI.
 *   editor  — adds, resolves, and deletes threads they authored.
 *   owner   — everything editor can do, plus delete anyone's thread.
 */

export interface ComposePrompt {
  markId: string
  quotedText: string
}

export interface CommentsPanelProps {
  documentId: string
  ydoc: Y.Doc
  role: AiperRole | null
  /**
   * Non-null when the parent has captured a selection and wants us to
   * render a compose form. Cleared by calling `onCancelCompose` or by
   * a successful `onSubmitCompose`. Auto-opens the drawer.
   */
  compose: ComposePrompt | null
  /**
   * Called with the composed body. Parent applies the mark to the
   * captured selection range and POSTs the comment. Resolves on
   * success; rejects with an Error whose `message` is human-readable.
   */
  onSubmitCompose: (body: string) => Promise<void>
  onCancelCompose: () => void
  /**
   * Called after a delete succeeds so the parent can remove the mark
   * from the shared Y.Doc — otherwise the highlight lingers as an
   * orphan for every peer.
   */
  onAfterDelete: (markId: string) => void
}

interface Thread {
  markId: string
  comments: Comment[]
  quotedText: string
  resolved: boolean
}

/**
 * `role === null` — the caller has no grant on the document; we do not
 * even render the FAB. This mirrors the server's viewer+ gate on
 * `GET /comments` — a call there would 404, so there is no list to
 * show.
 */
function canRead(role: AiperRole | null): boolean {
  return role !== null
}

function canWrite(role: AiperRole | null): boolean {
  return role === 'editor' || role === 'owner'
}

export function CommentsPanel({
  documentId,
  ydoc,
  role,
  compose,
  onSubmitCompose,
  onCancelCompose,
  onAfterDelete,
}: CommentsPanelProps) {
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refetchKey, setRefetchKey] = useState(0)
  const currentUserId = useSessionStore((s) => s.user?.id ?? null)
  const editable = canWrite(role)
  const isOwner = role === 'owner'

  // Open automatically when the parent hands us a compose prompt — we
  // never expect a compose to happen while closed.
  useEffect(() => {
    if (compose) setOpen(true)
  }, [compose])

  // Fetch on open + on refetch signal.
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    setError(null)
    listDocumentComments(documentId, ac.signal)
      .then((list) => {
        if (ac.signal.aborted) return
        setComments(list)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(describeError(err))
      })
    return () => ac.abort()
  }, [open, refetchKey, documentId])

  // Y.Doc observer — recompute the set of comment `markId`s in the
  // shared doc; refetch only when it changes. Debounced so a burst of
  // remote deltas triggers one fetch, not many.
  useEffect(() => {
    if (!open) return
    const frag = ydoc.getXmlFragment('default')
    let lastKey = commentMarkKey(frag)
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleCheck = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const nextKey = commentMarkKey(frag)
        if (nextKey !== lastKey) {
          lastKey = nextKey
          setRefetchKey((n) => n + 1)
        }
      }, 700)
    }
    frag.observeDeep(scheduleCheck)
    return () => {
      if (timer) clearTimeout(timer)
      frag.unobserveDeep(scheduleCheck)
    }
  }, [open, ydoc])

  const threads = useMemo(
    () => (comments ? groupThreads(comments) : []),
    [comments],
  )

  const handleSubmitCompose = useCallback(
    async (body: string) => {
      await onSubmitCompose(body)
      setRefetchKey((n) => n + 1)
    },
    [onSubmitCompose],
  )

  const handleResolve = useCallback(
    async (markId: string) => {
      await resolveCommentThread(documentId, markId)
      setRefetchKey((n) => n + 1)
    },
    [documentId],
  )

  const handleDelete = useCallback(
    async (markId: string) => {
      await deleteCommentThread(documentId, markId)
      onAfterDelete(markId)
      setRefetchKey((n) => n + 1)
    },
    [documentId, onAfterDelete],
  )

  const handleFocus = useCallback((markId: string) => {
    const target = document.querySelector<HTMLElement>(
      `.editor-page-content [data-comment-id="${cssEscape(markId)}"]`,
    )
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.classList.add('comment-highlight--flash')
      window.setTimeout(
        () => target.classList.remove('comment-highlight--flash'),
        1200,
      )
    }
  }, [])

  if (!canRead(role)) return null

  if (!open) {
    return (
      <button
        type="button"
        className="comments-fab"
        aria-label="Open comments"
        onClick={() => setOpen(true)}
      >
        <MessageCircle size={14} strokeWidth={1.5} />
        <span>Comments</span>
      </button>
    )
  }

  return (
    <aside
      className="comments-drawer"
      role="complementary"
      aria-label="Document comments"
    >
      <header className="comments-drawer-header">
        <h2 className="comments-drawer-title">Comments</h2>
        <button
          type="button"
          className="comments-drawer-close"
          aria-label="Close comments"
          onClick={() => setOpen(false)}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="comments-drawer-body">
        {compose && editable && (
          <ComposeForm
            key={compose.markId}
            prompt={compose}
            onSubmit={handleSubmitCompose}
            onCancel={onCancelCompose}
          />
        )}

        {error ? (
          <div className="comments-error">
            <p>{error}</p>
            <button type="button" onClick={() => setRefetchKey((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : comments === null ? (
          <p className="comments-muted">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="comments-muted">
            No comments yet — select text and hit “Comment” to start a thread.
          </p>
        ) : (
          <ol className="comments-list">
            {threads.map((t) => (
              <ThreadCard
                key={t.markId}
                thread={t}
                canWrite={editable}
                isOwner={isOwner}
                currentUserId={currentUserId}
                onResolve={handleResolve}
                onDelete={handleDelete}
                onFocus={handleFocus}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}

// ─── ComposeForm ─────────────────────────────────────────────────────────────

function ComposeForm({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: ComposePrompt
  onSubmit: (body: string) => Promise<void>
  onCancel: () => void
}) {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Focus the textarea when the form mounts. Deferred so the drawer's
  // own open animation doesn't steal focus back.
  useEffect(() => {
    const t = window.setTimeout(() => textareaRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = body.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmed)
      setBody('')
    } catch (err: unknown) {
      setError(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="comments-compose"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {prompt.quotedText && (
        <blockquote className="comments-compose-quote">
          {prompt.quotedText}
        </blockquote>
      )}
      <textarea
        ref={textareaRef}
        className="comments-compose-input"
        rows={3}
        placeholder="Add a comment…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={submitting}
        aria-label="Comment body"
      />
      {error && <p className="comments-compose-error">{error}</p>}
      <div className="comments-compose-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="submit"
          className="comments-compose-submit"
          disabled={submitting || body.trim().length === 0}
        >
          {submitting ? 'Posting…' : 'Comment'}
        </button>
      </div>
    </form>
  )
}

// ─── ThreadCard ──────────────────────────────────────────────────────────────

function ThreadCard({
  thread,
  canWrite: editable,
  isOwner,
  currentUserId,
  onResolve,
  onDelete,
  onFocus,
}: {
  thread: Thread
  canWrite: boolean
  isOwner: boolean
  currentUserId: string | null
  onResolve: (markId: string) => Promise<void>
  onDelete: (markId: string) => Promise<void>
  onFocus: (markId: string) => void
}) {
  const [busy, setBusy] = useState<'resolve' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // An editor without ownership can only delete threads they authored.
  // If the thread has any comment they did not author, we hide delete
  // — the server would 403 the request atomically anyway.
  const canDelete =
    isOwner ||
    (editable &&
      currentUserId != null &&
      thread.comments.every((c) => c.authorId === currentUserId))

  const resolve = async (): Promise<void> => {
    if (busy) return
    setBusy('resolve')
    setError(null)
    try {
      await onResolve(thread.markId)
    } catch (err: unknown) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const del = async (): Promise<void> => {
    if (busy) return
    setBusy('delete')
    setError(null)
    try {
      await onDelete(thread.markId)
    } catch (err: unknown) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li
      className={
        'comments-thread' +
        (thread.resolved ? ' comments-thread--resolved' : '')
      }
    >
      <button
        type="button"
        className="comments-thread-anchor"
        onClick={() => onFocus(thread.markId)}
        title="Scroll to highlight"
      >
        {thread.quotedText ? `“${truncate(thread.quotedText, 80)}”` : 'Selection'}
      </button>
      <ol className="comments-thread-list">
        {thread.comments.map((c) => (
          <li key={c.id} className="comments-comment">
            <div className="comments-comment-meta">
              <span className="comments-comment-author">
                {c.authorDisplayName}
              </span>
              <time
                className="comments-comment-time"
                dateTime={c.createdAt}
                title={c.createdAt}
              >
                {formatWhen(c.createdAt)}
              </time>
            </div>
            <p className="comments-comment-body">{c.body}</p>
          </li>
        ))}
      </ol>
      {(editable || canDelete) && (
        <div className="comments-thread-actions">
          {editable && !thread.resolved && (
            <button
              type="button"
              className="comments-thread-action"
              onClick={() => void resolve()}
              disabled={busy !== null}
              title="Resolve thread"
            >
              <Check size={12} strokeWidth={1.5} />
              <span>{busy === 'resolve' ? 'Resolving…' : 'Resolve'}</span>
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="comments-thread-action comments-thread-action--destructive"
              onClick={() => void del()}
              disabled={busy !== null}
              title="Delete thread"
            >
              <Trash2 size={12} strokeWidth={1.5} />
              <span>{busy === 'delete' ? 'Deleting…' : 'Delete'}</span>
            </button>
          )}
        </div>
      )}
      {error && <p className="comments-thread-error">{error}</p>}
    </li>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Group a flat, oldest-first list of `Comment`s by `markId`. Preserves
 * ordering: threads sort by their FIRST comment's `createdAt`, comments
 * within a thread stay in server order.
 */
function groupThreads(comments: Comment[]): Thread[] {
  const byMark = new Map<string, Thread>()
  for (const c of comments) {
    let t = byMark.get(c.markId)
    if (!t) {
      t = {
        markId: c.markId,
        comments: [],
        quotedText: c.quotedText,
        resolved: false,
      }
      byMark.set(c.markId, t)
    }
    t.comments.push(c)
    // A thread is considered resolved when EVERY comment has a
    // resolvedAt — matches the server's per-mark resolve semantics.
    if (c.resolvedAt) {
      t.resolved = t.comments.every((x) => x.resolvedAt !== null)
    } else {
      t.resolved = false
    }
  }
  return Array.from(byMark.values())
}

/**
 * Walk a Y.XmlFragment and collect every `markId` present as an
 * attribute on a `comment` mark inside any Y.XmlText descendant.
 * Returns a stable, sorted, comma-joined key suitable for equality
 * comparison across ticks.
 */
function commentMarkKey(node: Y.XmlFragment): string {
  const ids: string[] = []
  const walk = (n: unknown): void => {
    if (n instanceof Y.XmlText) {
      const delta = n.toDelta() as Array<{
        insert?: unknown
        attributes?: Record<string, unknown>
      }>
      for (const d of delta) {
        const attrs = d.attributes
        if (!attrs) continue
        const commentAttr = attrs['comment'] as
          | { markId?: unknown }
          | undefined
        if (commentAttr && typeof commentAttr.markId === 'string') {
          ids.push(commentAttr.markId)
        }
      }
    } else if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) {
      n.forEach(walk)
    }
  }
  node.forEach(walk)
  ids.sort()
  return ids.join(',')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * CSS.escape polyfill. jsdom and older browsers may not implement it;
 * we only escape enough to survive a uuid, which is safe already, but
 * being defensive keeps us from breaking if a future markId ever
 * carries a quote or backslash.
 */
function cssEscape(s: string): string {
  const w = window as unknown as { CSS?: { escape?: (s: string) => string } }
  if (w.CSS?.escape) return w.CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}

function describeError(err: unknown): string {
  if (err instanceof ApiFetchError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}
