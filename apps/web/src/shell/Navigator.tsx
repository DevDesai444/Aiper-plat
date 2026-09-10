import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  PanelLeftClose,
  Search,
  X,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ProjectFolderTree } from '@aiper/shared/types'
import { useUiStore } from './uiStore'
import { getProjectFolderTree } from '../api/endpoints'
import { ApiFetchError } from '../api/client'

type FolderEntry = ProjectFolderTree['folders'][number]

interface Row {
  entry: FolderEntry
  depth: number
}

/**
 * Left rail. When a project route is active (`/p/:pid/...`), fetches
 * `GET /api/v1/projects/:pid/folders` and renders the tree; otherwise
 * shows a lightweight empty state. Every subsequent PR (E7 documents,
 * E9 compat) reads the same tree — no per-consumer refetch.
 */
export function Navigator() {
  const leftOpen = useUiStore((s) => s.leftOpen)
  const toggleLeft = useUiStore((s) => s.toggleLeft)
  const navFilter = useUiStore((s) => s.navFilter)
  const setNavFilter = useUiStore((s) => s.setNavFilter)

  const { pid, fid, did } = useParams<{ pid?: string; fid?: string; did?: string }>()

  if (!leftOpen) {
    return (
      <aside className="navigator navigator--collapsed">
        <button
          type="button"
          className="navigator-expand-btn"
          onClick={toggleLeft}
          aria-label="Expand navigator"
        >
          <ChevronRight size={13} strokeWidth={1.5} />
        </button>
        <span className="navigator-collapsed-label">Navigator</span>
      </aside>
    )
  }

  return (
    <aside className="navigator">
      <div className="navigator-header">
        <span className="navigator-title">Files</span>
        <div className="navigator-header-spacer" />
        <button type="button" aria-label="Collapse navigator" onClick={toggleLeft}>
          <PanelLeftClose size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="navigator-filter">
        <Search size={12} strokeWidth={1.5} />
        <input
          type="search"
          value={navFilter}
          placeholder="Filter files and folders"
          onChange={(e) => setNavFilter(e.target.value)}
        />
        {navFilter && (
          <button type="button" aria-label="Clear filter" onClick={() => setNavFilter('')}>
            <X size={11} strokeWidth={1.5} />
          </button>
        )}
      </div>

      <div className="navigator-body">
        {pid ? (
          <FolderTree pid={pid} activeFolderId={fid ?? null} activeDocId={did ?? null} />
        ) : (
          <div className="navigator-empty">
            <p>Open a project to see its folders here.</p>
          </div>
        )}
      </div>
    </aside>
  )
}

/**
 * Fetches `getProjectFolderTree(pid)`, computes each entry's depth from the
 * flat DFS-preorder walk, filters by `navFilter`, and renders folders +
 * documents with click-through navigation.
 */
function FolderTree({
  pid,
  activeFolderId,
  activeDocId,
}: {
  pid: string
  activeFolderId: string | null
  activeDocId: string | null
}) {
  const navigate = useNavigate()
  const [tree, setTree] = useState<ProjectFolderTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const navFilter = useUiStore((s) => s.navFilter)

  useEffect(() => {
    setTree(null)
    setError(null)
    setLoading(true)
    const ac = new AbortController()
    getProjectFolderTree(pid, ac.signal)
      .then(setTree)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(
          err instanceof ApiFetchError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Could not load project folders.',
        )
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [pid])

  const rows = useMemo<Row[]>(() => {
    if (!tree) return []
    const depths = new Map<string, number>()
    return tree.folders.map((entry) => {
      const depth =
        entry.folder.parentFolderId === null
          ? 0
          : (depths.get(entry.folder.parentFolderId) ?? 0) + 1
      depths.set(entry.folder.id, depth)
      return { entry, depth }
    })
  }, [tree])

  const filter = navFilter.trim().toLowerCase()

  // Filter: keep a row if its folder name matches or if any of its documents match.
  // A blank filter keeps every row. When the filter is active we ignore the
  // collapsed set — the filtered view expands whatever survived so the user
  // can see the match, matching legacy behaviour.
  const visibleRows = useMemo(() => {
    if (!filter) return rows
    return rows.filter(
      (r) =>
        r.entry.folder.name.toLowerCase().includes(filter) ||
        r.entry.documents.some((d) => d.title.toLowerCase().includes(filter)),
    )
  }, [rows, filter])

  if (error) {
    return (
      <div className="navigator-empty">
        <p className="navigator-error">{error}</p>
      </div>
    )
  }
  if (loading) return <div className="navigator-empty">Loading…</div>
  if (!tree || tree.folders.length === 0) {
    return (
      <div className="navigator-empty">
        <p>No folders in this project yet.</p>
      </div>
    )
  }
  if (visibleRows.length === 0) {
    return (
      <div className="navigator-empty">
        <p>Nothing matches “{filter}”.</p>
      </div>
    )
  }

  const toggleCollapse = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // When filter is active, treat every ancestor of a visible row as expanded.
  const ancestorsExpanded = (parentId: string | null): boolean => {
    if (parentId === null) return true
    if (filter) return true
    return !collapsed.has(parentId)
  }

  return (
    <div className="tree-list">
      {visibleRows.map(({ entry, depth }) => {
        const isFolderActive = entry.folder.id === activeFolderId
        if (!ancestorsExpanded(entry.folder.parentFolderId)) return null
        const isCollapsed = collapsed.has(entry.folder.id) && !filter

        return (
          <div key={entry.folder.id}>
            <div
              className={`tree-row tree-row--folder${isFolderActive ? ' is-selected' : ''}`}
              style={{ paddingLeft: 9 + depth * 13 }}
              onClick={() => navigate(`/p/${tree.project.id}/f/${entry.folder.id}`)}
            >
              <button
                type="button"
                className="tree-caret-btn"
                aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCollapse(entry.folder.id)
                }}
              >
                {isCollapsed ? (
                  <ChevronRight size={11} strokeWidth={1.5} />
                ) : (
                  <ChevronDown size={11} strokeWidth={1.5} />
                )}
              </button>
              {isCollapsed ? (
                <Folder size={13} strokeWidth={1.5} className="tree-icon" />
              ) : (
                <FolderOpen size={13} strokeWidth={1.5} className="tree-icon" />
              )}
              <span className="tree-label" title={entry.folder.name}>
                {entry.folder.name}
              </span>
            </div>

            {!isCollapsed &&
              entry.documents.map((d) => (
                <div
                  key={d.id}
                  className={`tree-row${d.id === activeDocId ? ' is-selected' : ''}`}
                  style={{ paddingLeft: 9 + (depth + 1) * 13 }}
                  onClick={() =>
                    navigate(`/p/${tree.project.id}/f/${entry.folder.id}/d/${d.id}`)
                  }
                  title={d.title}
                >
                  <span className="tree-caret-spacer" />
                  <FileText size={13} strokeWidth={1.5} className="tree-icon" />
                  <span className="tree-label">{d.title}</span>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}
