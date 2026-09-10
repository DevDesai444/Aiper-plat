import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Project } from '@aiper/shared/types'
import { getProject } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import './pages.css'

/**
 * /p/:pid — project metadata + jump-off tiles. The folder tree is already
 * in the Navigator on the left, so this page is intentionally sparse:
 * confirms you are looking at the right project and offers the two
 * project-wide destinations (product tree and compatibility dashboard).
 */
export function ProjectOverviewPage() {
  const { pid } = useParams<{ pid: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pid) return
    const ac = new AbortController()
    setError(null)
    setProject(null)
    getProject(pid, ac.signal)
      .then(setProject)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(
          err instanceof ApiFetchError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Could not load project.',
        )
      })
    return () => ac.abort()
  }, [pid])

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{project?.name ?? 'Project'}</h1>
        <p className="page-sub">
          {project ? project.slug : pid} —{' '}
          <Link to={`/orgs/${project?.orgId ?? ''}`}>back to org</Link>
        </p>
      </header>

      {error && <div className="page-error">{error}</div>}

      {project && (
        <>
          <section className="page-section">
            <div className="page-section-label">Your access</div>
            <p>{project.myRole ?? 'no access'}</p>
          </section>

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
        </>
      )}
    </div>
  )
}
