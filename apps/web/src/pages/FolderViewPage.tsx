import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Document, Folder } from '@aiper/shared/types'
import { createDocument, getFolder, listFolderDocuments } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import { CreateRow } from './CreateRow'
import { RowActions } from '../components/RowActions'
import '../components/rowActions.css'
import './pages.css'

/**
 * /p/:pid/f/:fid — one folder's metadata + the documents it directly
 * contains. Sub-folders are still reached from the Navigator, which shows
 * the whole tree; showing them on the page too would just duplicate.
 *
 * Each document row hosts a `<RowActions>` menu (Rename / Move / Delete)
 * gated by that row's `myRole`; the parent's own actions on the folder
 * itself live in the Navigator's row for the folder.
 */
export function FolderViewPage() {
  const { pid, fid } = useParams<{ pid: string; fid: string }>()
  const navigate = useNavigate()
  const [folder, setFolder] = useState<Folder | null>(null)
  const [documents, setDocuments] = useState<Document[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!fid) return
      setError(null)
      try {
        const [f, docs] = await Promise.all([
          getFolder(fid, signal),
          listFolderDocuments(fid, signal),
        ])
        if (signal?.aborted) return
        setFolder(f)
        setDocuments(docs)
      } catch (err) {
        if (signal?.aborted) return
        setError(errText(err, 'Could not load folder.'))
      }
    },
    [fid],
  )

  useEffect(() => {
    const ac = new AbortController()
    setFolder(null)
    setDocuments(null)
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{folder?.name ?? 'Folder'}</h1>
        <p className="page-sub">
          <Link to={`/p/${pid}`}>back to project</Link>
        </p>
      </header>

      {error && <div className="page-error">{error}</div>}

      <section className="page-section">
        <div className="page-section-label">Documents</div>
        {documents === null ? (
          <p className="page-muted">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="page-muted">No documents in this folder yet.</p>
        ) : (
          <div className="card-list">
            {documents.map((d) => (
              <DocumentCard
                key={d.id}
                doc={d}
                onOpen={() => navigate(`/p/${pid}/f/${fid}/d/${d.id}`)}
                projectId={pid!}
                currentFolderId={fid!}
                onChanged={() => load()}
              />
            ))}
          </div>
        )}
        {fid && (
          <CreateRow
            placeholder="New document title — e.g. TVAC Test Report"
            buttonLabel="Create document"
            onCreate={async (title) => {
              const doc = await createDocument(fid, title)
              navigate(`/p/${pid}/f/${fid}/d/${doc.id}`)
            }}
          />
        )}
      </section>
    </div>
  )
}

/**
 * Card row for one document. Clicking anywhere but the `⋯` menu opens the
 * document; the menu (and its dialogs) stop propagation so a role change /
 * delete never accidentally navigates the user into the doc being modified.
 */
function DocumentCard({
  doc,
  onOpen,
  projectId,
  currentFolderId,
  onChanged,
}: {
  doc: Document
  onOpen: () => void
  projectId: string
  currentFolderId: string
  onChanged: () => void | Promise<void>
}) {
  return (
    <div
      className="card"
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      style={{ position: 'relative' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span className="card-title">{doc.title}</span>
          <span className="card-sub">{doc.kind}</span>
          {doc.myRole && <span className="card-tag">{doc.myRole}</span>}
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <RowActions
            subjectType="document"
            subjectId={doc.id}
            subjectLabel={doc.title}
            role={doc.myRole}
            projectId={projectId}
            currentParent={{ kind: 'folder', folderId: currentFolderId }}
            onChanged={onChanged}
          />
        </div>
      </div>
    </div>
  )
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiFetchError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return fallback
}
