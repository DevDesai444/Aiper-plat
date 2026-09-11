import { useEffect, useMemo, useState } from 'react'
import { Clock, X } from 'lucide-react'
import type { DocumentSnapshot } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import { getDocumentHistory } from '../api/endpoints'
import { useSessionStore } from '../auth/sessionStore'
import './history.css'

/**
 * Save-timeline panel for one document. Rendered as a bottom-right FAB that
 * toggles a right-side drawer — a self-contained overlay so this component
 * can be mounted anywhere in the editor without CSS-position gymnastics on
 * the host.
 *
 * PR-1 scope: read the timeline metadata (E3's
 * `GET /api/v1/documents/:did/history`) and render one row per snapshot,
 * newest-first. Fetches on first open — the timeline is invisible until
 * the user asks for it, so there is no reason to burn a request on mount.
 *
 * `savedBy` renders as "You" when it matches the signed-in user; otherwise
 * a short uuid with the full one in a title tooltip. The server does not
 * currently join a display name onto the row (see `types/snapshots.ts` —
 * "a display name is left for the read route to join in when humans need
 * to see the timeline"); when it does, this component just swaps its
 * `displayNameFor()` call.
 *
 * Stretch (previewing a snapshot's state via `getSnapshotState` + Yjs) is
 * deliberately out of scope — the read-only editor already hydrates from
 * `currentSnapshotId`; wiring "preview snapshot X" needs an editor-side
 * hook the E7 edit+save PR will land alongside its own state model.
 */
export function HistoryPanel({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const currentUserId = useSessionStore((s) => s.user?.id ?? null)

  // Fetch on open (and on retry). Aborts on close so a slow response does
  // not repopulate a drawer the user has already dismissed.
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    setError(null)
    setSnapshots(null)
    getDocumentHistory(documentId, ac.signal)
      .then(setSnapshots)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(describeError(err))
      })
    return () => ac.abort()
  }, [open, attempt, documentId])

  if (!open) {
    return (
      <button
        type="button"
        className="history-fab"
        aria-label="Open save history"
        onClick={() => setOpen(true)}
      >
        <Clock size={14} strokeWidth={1.5} />
        <span>History</span>
      </button>
    )
  }

  return (
    <aside className="history-drawer" role="complementary" aria-label="Save history">
      <header className="history-drawer-header">
        <h2 className="history-drawer-title">Save history</h2>
        <button
          type="button"
          className="history-drawer-close"
          aria-label="Close save history"
          onClick={() => setOpen(false)}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="history-drawer-body">
        {error ? (
          <div className="history-error">
            <p>{error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : snapshots === null ? (
          <p className="history-muted">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="history-muted">
            No saves yet — every checkpoint you Save will show up here.
          </p>
        ) : (
          <ol className="history-list">
            {snapshots.map((s) => (
              <HistoryRow key={s.id} snap={s} currentUserId={currentUserId} />
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}

function HistoryRow({
  snap,
  currentUserId,
}: {
  snap: DocumentSnapshot
  currentUserId: string | null
}) {
  const who = displayNameFor(snap.savedBy, currentUserId)
  const when = useMemo(() => formatSavedAt(snap.savedAt), [snap.savedAt])
  return (
    <li className="history-row" data-reason={snap.reason}>
      <div className="history-row-head">
        <span className={`history-reason history-reason--${snap.reason}`}>
          {snap.reason}
        </span>
        {snap.label && <span className="history-label">{snap.label}</span>}
      </div>
      <div className="history-row-meta">
        <span title={snap.savedBy}>{who}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={snap.savedAt}>{when}</time>
      </div>
    </li>
  )
}

/**
 * Best-effort display for a savedBy uuid. When the timeline row was saved
 * by the signed-in user, render "You"; otherwise show the id's leading 8
 * characters (enough to disambiguate two saves by different colleagues in a
 * row) with the full uuid in a title tooltip. Server-side display-name
 * join is a future improvement — see the file header.
 */
function displayNameFor(savedBy: string, currentUserId: string | null): string {
  if (currentUserId && savedBy === currentUserId) return 'You'
  return `u:${savedBy.slice(0, 8)}`
}

function formatSavedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function describeError(err: unknown): string {
  if (err instanceof ApiFetchError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return 'Could not load save history.'
}
