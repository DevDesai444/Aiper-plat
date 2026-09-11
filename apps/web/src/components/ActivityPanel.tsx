import { useCallback, useEffect, useState } from 'react'
import type { AuditEntryRead } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import { getAuditPage } from '../api/endpoints'
import { labelForAction } from './actionLabels'
import './activity.css'

const PAGE_SIZE = 25

/**
 * Activity feed for a project. Fetches the audit log scoped to
 * `subjectType=project&subjectId=<projectId>` — E1's server filters by
 * `aiper_effective_access` so the caller sees only events on things they
 * can reach.
 *
 * Presentation is a flat scrollable list: `<Actor> <label> · <relative
 * time>`. `labelForAction` maps action codes to phrases; unknown codes
 * fall through to a slug-humanised form so a peer engineer's new action
 * still reads plainly.
 *
 * Pagination is cursor-based: initial fetch on mount, subsequent pages
 * via a Load More button that passes the previous page's `nextCursor`.
 * A returned `nextCursor === null` means the page IS the last, and the
 * Load More button hides.
 *
 * Self-contained: styles are `activity.css`; the host only mounts
 * `<ActivityPanel projectId={project.id}/>`.
 */
export function ActivityPanel({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<AuditEntryRead[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadFirstPage = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const page = await getAuditPage(
          { subjectType: 'project', subjectId: projectId, limit: PAGE_SIZE },
          signal,
        )
        if (signal?.aborted) return
        setEntries(page.entries)
        setNextCursor(page.nextCursor)
      } catch (err) {
        if (signal?.aborted) return
        setError(errText(err))
        setEntries([])
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [projectId],
  )

  useEffect(() => {
    setEntries(null)
    setNextCursor(null)
    const ac = new AbortController()
    void loadFirstPage(ac.signal)
    return () => ac.abort()
  }, [loadFirstPage])

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loading) return
    setLoading(true)
    setError(null)
    try {
      const page = await getAuditPage({
        subjectType: 'project',
        subjectId: projectId,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      })
      setEntries((prev) => (prev ? [...prev, ...page.entries] : page.entries))
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="activity-panel">
      {error && (
        <div className="activity-error">
          <p>{error}</p>
          <button type="button" onClick={() => void loadFirstPage()}>
            Retry
          </button>
        </div>
      )}

      {entries === null && !error && (
        <p className="activity-muted">Loading activity…</p>
      )}

      {entries !== null && entries.length === 0 && !error && (
        <p className="activity-muted">No activity yet — new events show up here.</p>
      )}

      {entries !== null && entries.length > 0 && (
        <ol className="activity-list">
          {entries.map((entry) => (
            <li key={entry.id} className="activity-row">
              <span className="activity-actor">{entry.printedName}</span>
              <span className="activity-verb">{labelForAction(entry.action)}</span>
              {entry.reason && (
                <span className="activity-reason" title={entry.reason}>
                  — {entry.reason}
                </span>
              )}
              <time className="activity-when" dateTime={entry.occurredAt}>
                {relativeTime(entry.occurredAt)}
              </time>
            </li>
          ))}
        </ol>
      )}

      {nextCursor && (
        <div className="activity-more">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Rough relative-time formatter — reads a whole feed at a glance without
 * a dependency on Intl.RelativeTimeFormat's noun forms in every locale.
 * Anything older than a week rolls over to an absolute short-date;
 * regulators tend to want the exact day past that horizon anyway.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 90) return 'a minute ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function errText(err: unknown): string {
  if (err instanceof ApiFetchError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return 'Could not load activity.'
}
