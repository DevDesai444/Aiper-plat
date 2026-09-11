import { useEffect, useId, useMemo, useState } from 'react'
import type { ProjectFolderTree } from '@aiper/shared/types'
import { Modal } from './Modal'
import { ApiFetchError } from '../api/client'
import { getProjectFolderTree } from '../api/endpoints'
import './rowActions.css'

/**
 * Move a document / folder to another location in the SAME project. The
 * server rejects cross-project moves with a 400; we surface only in-project
 * targets so the user cannot construct a request that would fail that guard.
 *
 * Renders the project's folder tree as a flat DFS-preorder list with
 * depth-based indent (same shape the Navigator uses) plus a "Project root"
 * option at the top. Folders that would create a cycle (moving folder F
 * into F itself or into any descendant of F) are shown but disabled — the
 * server also catches this with `folder_cycle`, but hiding the button
 * before the round-trip is clearer.
 */
export function MoveDialog({
  subjectType,
  subjectLabel,
  projectId,
  /** Folder id being moved — used to disable self / descendant targets when
   *  moving a folder. Omit for documents. */
  currentFolderId,
  /** Current parent of the subject (folderId, projectId or `null` for a
   *  folder already at the project root). Disables the matching target row
   *  since re-moving to the current location is a no-op. */
  currentParent,
  onMove,
  onClose,
}: {
  subjectType: 'document' | 'folder'
  subjectLabel: string
  projectId: string
  currentFolderId?: string
  currentParent: { kind: 'root' } | { kind: 'folder'; folderId: string }
  /**
   * Fires with the picked target. `{ kind: 'root' }` means move to the
   * project root; `{ kind: 'folder', folderId }` means move into that
   * folder. Returns a promise so this dialog can surface a server error
   * (e.g. a race that flipped roles) inline.
   */
  onMove: (target: { kind: 'root' } | { kind: 'folder'; folderId: string }) => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [tree, setTree] = useState<ProjectFolderTree | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getProjectFolderTree(projectId, ac.signal)
      .then(setTree)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setLoadError(errText(err, 'Could not load folder tree.'))
      })
    return () => ac.abort()
  }, [projectId])

  // Fold the flat DFS-preorder walk into rows with depth for indent.
  const rows = useMemo(() => {
    if (!tree) return [] as Array<{ id: string; name: string; depth: number }>
    const depths = new Map<string, number>()
    return tree.folders.map((e) => {
      const depth =
        e.folder.parentFolderId === null
          ? 0
          : (depths.get(e.folder.parentFolderId) ?? 0) + 1
      depths.set(e.folder.id, depth)
      return { id: e.folder.id, name: e.folder.name, depth }
    })
  }, [tree])

  // For a folder move, precompute which targets would create a cycle:
  // the folder itself + every descendant folder. Documents have no cycle
  // concern.
  const forbidden = useMemo(() => {
    if (subjectType !== 'folder' || !currentFolderId || !tree) return new Set<string>()
    const s = new Set<string>([currentFolderId])
    // A single pass in DFS order suffices: any folder whose parent is
    // already in `s` is a descendant of the moved folder.
    for (const e of tree.folders) {
      if (e.folder.parentFolderId && s.has(e.folder.parentFolderId)) {
        s.add(e.folder.id)
      }
    }
    return s
  }, [subjectType, currentFolderId, tree])

  const choose = async (
    target: { kind: 'root' } | { kind: 'folder'; folderId: string },
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onMove(target)
      onClose()
    } catch (err) {
      setError(errText(err, 'Move failed.'))
    } finally {
      setBusy(false)
    }
  }

  const rootIsCurrent = currentParent.kind === 'root'

  return (
    <Modal onClose={onClose} titleId={titleId}>
      <div className="modal-header">
        <div>
          <h2 id={titleId} className="modal-title">
            Move {subjectType}
          </h2>
          <p className="modal-sub">{subjectLabel} — pick a destination</p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="modal-body">
        {loadError && <div className="row-dialog-error">{loadError}</div>}
        {error && <div className="row-dialog-error">{error}</div>}
        {tree === null && !loadError ? (
          <p className="row-dialog-muted">Loading folders…</p>
        ) : (
          <ul className="move-list">
            <li>
              <button
                type="button"
                className="move-target"
                disabled={busy || rootIsCurrent}
                onClick={() => void choose({ kind: 'root' })}
              >
                <span className="move-target-name">Project root</span>
                {rootIsCurrent && <span className="move-target-tag">Current</span>}
              </button>
            </li>
            {rows.map((r) => {
              const isCurrent =
                currentParent.kind === 'folder' && currentParent.folderId === r.id
              const isForbidden = forbidden.has(r.id)
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="move-target"
                    style={{ paddingLeft: 12 + r.depth * 14 }}
                    disabled={busy || isCurrent || isForbidden}
                    onClick={() => void choose({ kind: 'folder', folderId: r.id })}
                    title={
                      isForbidden
                        ? 'Cannot move a folder into itself or one of its descendants'
                        : undefined
                    }
                  >
                    <span className="move-target-name">{r.name}</span>
                    {isCurrent && <span className="move-target-tag">Current</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiFetchError) return err.message || fallback
  if (err instanceof Error) return err.message
  return fallback
}
