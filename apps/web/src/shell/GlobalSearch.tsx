import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import type { SearchResult } from '@aiper/shared/types'
import { ApiFetchError } from '../api/client'
import { searchDocuments, searchInProject } from '../api/endpoints'
import './search.css'

const DEBOUNCE_MS = 250
const RESULT_LIMIT = 20

/**
 * Global search — top-bar affordance. Debounced substring search on document
 * titles, backed by E1's `/api/v1/search` (or `/api/v1/projects/:pid/search`
 * when the user is inside a project). Results dropdown opens below the
 * input; clicking a hit navigates to the document's editor.
 *
 * Scope: when the user is on a `/p/:pid` route, the search auto-narrows to
 * that project. Elsewhere (Dashboard, org overview, settings) it searches
 * every project the caller can reach. The dropdown shows a scope hint so
 * the behaviour isn't surprising.
 *
 * The server already filters through `aiper_effective_access`, so a caller
 * can only ever see results they can open — no per-row 403 handling on
 * the UI side.
 */
export function GlobalSearch() {
  const navigate = useNavigate()
  const { pid } = useParams<{ pid?: string }>()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Debounced fetch. Every keystroke schedules a run 250ms later; the next
  // keystroke or an unmount cancels it. An AbortController on top of the
  // debounce means a fetch that was already inflight when the user typed
  // again does not overwrite results from a NEWER query.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setError(null)
      setLoading(false)
      return
    }
    const ac = new AbortController()
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const hits = pid
          ? await searchInProject(pid, q, RESULT_LIMIT, ac.signal)
          : await searchDocuments(q, RESULT_LIMIT, ac.signal)
        if (ac.signal.aborted) return
        setResults(hits)
      } catch (err) {
        if (ac.signal.aborted) return
        setError(errText(err))
        setResults([])
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(handle)
      ac.abort()
    }
  }, [query, pid])

  // Outside-click / Escape close the dropdown. Blur alone doesn't work —
  // it fires when clicking a result and would race the nav handler.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const goTo = (r: SearchResult): void => {
    setOpen(false)
    const url =
      r.folder === null
        ? `/p/${r.project.id}/d/${r.document.id}`
        : `/p/${r.project.id}/f/${r.folder.id}/d/${r.document.id}`
    navigate(url)
  }

  // On Enter with results, open the first — the common "just find it and
  // go" case. Without results (or while still loading), Enter is a no-op.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && results && results.length > 0) {
      e.preventDefault()
      goTo(results[0]!)
    }
  }

  const clear = (): void => {
    setQuery('')
    setResults(null)
    setError(null)
    setOpen(false)
  }

  const showDropdown = open && query.trim().length > 0

  return (
    <div className="global-search" ref={wrapRef}>
      <label className="global-search-input">
        <Search size={13} strokeWidth={1.5} className="global-search-icon" />
        <input
          type="search"
          value={query}
          placeholder={pid ? 'Search in this project…' : 'Search documents…'}
          aria-label={pid ? 'Search in this project' : 'Search documents'}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            if (query.trim()) setOpen(true)
          }}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button
            type="button"
            className="global-search-clear"
            aria-label="Clear search"
            onClick={clear}
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        )}
      </label>

      {showDropdown && (
        <div className="global-search-dropdown" role="listbox">
          {loading && <div className="global-search-status">Searching…</div>}
          {!loading && error && (
            <div className="global-search-status global-search-status--error">
              {error}
            </div>
          )}
          {!loading && !error && results !== null && results.length === 0 && (
            <div className="global-search-status">
              No matches{pid ? ' in this project' : ''}.
            </div>
          )}
          {!loading && !error && results && results.length > 0 && (
            <>
              <div className="global-search-scope">
                {pid ? 'Searching this project' : 'Searching everywhere you have access'}
              </div>
              <ul className="global-search-list">
                {results.map((r) => (
                  <li key={r.document.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      className="global-search-result"
                      onClick={() => goTo(r)}
                    >
                      <span className="global-search-title">{r.document.title}</span>
                      <span className="global-search-crumb">
                        {r.project.name}
                        {r.folder && <> / {r.folder.name}</>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function errText(err: unknown): string {
  if (err instanceof ApiFetchError) return err.message || 'Search failed.'
  if (err instanceof Error) return err.message
  return 'Search failed.'
}
