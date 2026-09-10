import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Organization, Project } from '@aiper/shared/types'
import { listOrgs, listProjectsInOrg } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import './pages.css'

/**
 * /orgs/:oid — the org's projects. Org name comes from the (small)
 * `listOrgs` payload rather than a dedicated GET /orgs/:oid (which the
 * server does not expose); if the org isn't in that list, the caller is
 * not a member of it and rendering blank is correct.
 */
export function OrgOverviewPage() {
  const { oid } = useParams<{ oid: string }>()
  const [org, setOrg] = useState<Organization | 'missing' | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!oid) return
    const ac = new AbortController()
    setError(null)
    setOrg(null)
    setProjects(null)
    Promise.all([listOrgs(ac.signal), listProjectsInOrg(oid, ac.signal)])
      .then(([orgs, projects]) => {
        setOrg(orgs.find((o) => o.id === oid) ?? 'missing')
        setProjects(projects)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(
          err instanceof ApiFetchError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Could not load organization.',
        )
      })
    return () => ac.abort()
  }, [oid])

  const orgName = org && org !== 'missing' ? org.name : oid

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{orgName}</h1>
        <p className="page-sub">
          <Link to="/">All organizations</Link>
        </p>
      </header>

      <section className="page-section">
        <div className="page-section-label">Projects</div>
        {error ? (
          <div className="page-error">{error}</div>
        ) : projects === null ? (
          <p className="page-muted">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="page-muted">No projects you can access in this org.</p>
        ) : (
          <div className="card-list">
            {projects.map((p) => (
              <Link key={p.id} to={`/p/${p.id}`} className="card">
                <span className="card-title">{p.name}</span>
                <span className="card-sub">{p.slug}</span>
                {p.myRole && <span className="card-tag">{p.myRole}</span>}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
