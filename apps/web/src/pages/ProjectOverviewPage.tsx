import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Document, Project } from '@aiper/shared/types'
import {
  createFolder,
  createProjectDocument,
  getProject,
  listProjectDocuments,
} from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import { ShareDialog } from '../components/ShareDialog'
import { RowActions } from '../components/RowActions'
import { ActivityPanel } from '../components/ActivityPanel'
import '../components/share.css'
import '../components/rowActions.css'
import './pages.css'

type CreateMode = 'folder' | 'document'

/**
 * /p/:pid — project metadata + create surface. A project holds folders AND
 * documents directly, so the create control is a split button: the primary
 * action is "Create folder", and the caret switches it to "Create document".
 */
export function ProjectOverviewPage() {
  const { pid } = useParams<{ pid: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showShare, setShowShare] = useState(false)

  const load = (signal?: AbortSignal): void => {
    if (!pid) return
    getProject(pid, signal)
      .then(setProject)
      .catch((err: unknown) => {
        if (signal?.aborted) return
        setError(errMessage(err, 'Could not load project.'))
      })
    listProjectDocuments(pid, signal)
      .then(setDocuments)
      .catch(() => {
        /* project-root documents are secondary; a load failure here is non-fatal */
      })
  }

  useEffect(() => {
    const ac = new AbortController()
    setError(null)
    setProject(null)
    setDocuments([])
    load(ac.signal)
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  return (
    <div className="page">
      <header
        className="page-header"
        style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}
      >
        <div>
          <h1 className="page-title">{project?.name ?? 'Project'}</h1>
          <p className="page-sub">
            {project ? project.slug : pid} —{' '}
            <Link to={`/orgs/${project?.orgId ?? ''}`}>back to org</Link>
          </p>
        </div>
        {project && (
          <button
            type="button"
            className="share-open-btn"
            onClick={() => setShowShare(true)}
          >
            Share
          </button>
        )}
      </header>

      {project && showShare && (
        <ShareDialog
          subjectType="project"
          subjectId={project.id}
          subjectLabel={project.name}
          callerRole={project.myRole}
          onClose={() => setShowShare(false)}
        />
      )}

      {error && <div className="page-error">{error}</div>}

      {project && (
        <>
          <section className="page-section">
            <div className="page-section-label">Your access</div>
            <p>{project.myRole ?? 'no access'}</p>
          </section>

          <section className="page-section">
            <div className="page-section-label">Create</div>
            <p className="page-muted">
              Folders and documents both live under this project. Documents you
              create here sit directly in the project, not inside a folder.
            </p>
            <SplitCreate
              onCreateFolder={async (name) => {
                const folder = await createFolder(project.id, name)
                navigate(`/p/${project.id}/f/${folder.id}`)
              }}
              onCreateDocument={async (title) => {
                const doc = await createProjectDocument(project.id, title)
                setDocuments((prev) =>
                  [...prev, doc].sort((a, b) =>
                    a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
                  ),
                )
              }}
            />
          </section>

          {documents.length > 0 && (
            <section className="page-section">
              <div className="page-section-label">Documents in this project</div>
              <div className="card-list">
                {documents.map((d) => (
                  <div key={d.id} className="card card--static">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                        <span className="card-title">{d.title}</span>
                        <span className="card-sub">{d.kind}</span>
                        {d.myRole && <span className="card-tag">{d.myRole}</span>}
                      </div>
                      <RowActions
                        subjectType="document"
                        subjectId={d.id}
                        subjectLabel={d.title}
                        role={d.myRole}
                        projectId={project.id}
                        currentParent={{ kind: 'root' }}
                        onChanged={() => load()}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="page-section">
            <div className="page-section-label">Project surfaces</div>
            <div className="card-list">
              <Link to={`/p/${project.id}/tree`} className="card">
                <span className="card-title">Product tree</span>
                <span className="card-sub">Component hierarchy — E9</span>
              </Link>
              <Link to={`/p/${project.id}/compat`} className="card">
                <span className="card-title">Compatibility dashboard</span>
                <span className="card-sub">Cross-document findings — E9</span>
              </Link>
            </div>
          </section>

          <section className="page-section">
            <div className="page-section-label">Activity</div>
            <ActivityPanel projectId={project.id} />
          </section>
        </>
      )}
    </div>
  )
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiFetchError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return fallback
}

/**
 * Text input + split button. Primary click runs the current mode's action;
 * the caret opens a menu to switch between "folder" and "document".
 */
function SplitCreate({
  onCreateFolder,
  onCreateDocument,
}: {
  onCreateFolder: (name: string) => Promise<void>
  onCreateDocument: (title: string) => Promise<void>
}) {
  const [mode, setMode] = useState<CreateMode>('folder')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close the menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const label = mode === 'folder' ? 'Create folder' : 'Create document'
  const placeholder =
    mode === 'folder'
      ? 'New folder name — e.g. TCS'
      : 'New document title — e.g. TVAC Test Report'

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'folder') await onCreateFolder(trimmed)
      else await onCreateDocument(trimmed)
      setName('')
    } catch (err) {
      setError(errMessage(err, 'Create failed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="create-block" ref={wrapRef}>
      <form
        className="create-row"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          type="text"
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <div className="split-button">
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : label}
          </button>
          <button
            type="button"
            className="split-caret"
            aria-label="Choose what to create"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={() => setMenuOpen((o) => !o)}
          >
            ▾
          </button>
          {menuOpen && (
            <div className="split-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className={mode === 'folder' ? 'is-active' : ''}
                onClick={() => {
                  setMode('folder')
                  setMenuOpen(false)
                }}
              >
                Create folder
              </button>
              <button
                type="button"
                role="menuitem"
                className={mode === 'document' ? 'is-active' : ''}
                onClick={() => {
                  setMode('document')
                  setMenuOpen(false)
                }}
              >
                Create document
              </button>
            </div>
          )}
        </div>
      </form>
      {error && <div className="create-error">{error}</div>}
    </div>
  )
}
