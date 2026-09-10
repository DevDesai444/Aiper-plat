import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Document, Folder } from '@aiper/shared/types'
import { getFolder, listFolderDocuments } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import './pages.css'

/**
 * /p/:pid/f/:fid — one folder's metadata + the documents it directly
 * contains. Sub-folders are still reached from the Navigator, which shows
 * the whole tree; showing them on the page too would just duplicate.
 */
export function FolderViewPage() {
  const { pid, fid } = useParams<{ pid: string; fid: string }>()
  const [folder, setFolder] = useState<Folder | null>(null)
  const [documents, setDocuments] = useState<Document[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!fid) return
    const ac = new AbortController()
    setError(null)
    setFolder(null)
    setDocuments(null)
    Promise.all([getFolder(fid, ac.signal), listFolderDocuments(fid, ac.signal)])
      .then(([f, docs]) => {
        setFolder(f)
        setDocuments(docs)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(
          err instanceof ApiFetchError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Could not load folder.',
        )
      })
    return () => ac.abort()
  }, [fid])

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
              <Link key={d.id} to={`/p/${pid}/f/${fid}/d/${d.id}`} className="card">
                <span className="card-title">{d.title}</span>
                <span className="card-sub">{d.kind}</span>
                {d.myRole && <span className="card-tag">{d.myRole}</span>}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
