import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Organization, Project } from '@aiper/shared/types'
import { createProject, listOrgs, listProjectsInOrg } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import { useSessionStore } from '../auth/sessionStore'
import { CreateRow } from './CreateRow'
import './pages.css'

/**
 * Landing page after sign-in. One deployment serves one organization
 * (on-prem model), so there is no org picker: the page loads the org,
 * lists its projects, and offers "New project" inline. The org concept
 * survives in the schema for a future multi-tenant mode but never
 * surfaces in the UI.
 */
export function DashboardPage() {
  const user = useSessionStore((s) => s.user)
  const [org, setOrg] = useState<Organization | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null)
    try {
      const orgs = await listOrgs(signal)
      if (orgs.length === 0) {
        // Provisioning adds every user to the deployment org on their
        // first request; an empty list here means that request IS the
        // first one — /me raced the org lookup. One retry settles it.
        const retry = await listOrgs(signal)
        if (retry.length === 0) {
          setError('This deployment has no organization yet — check server logs.')
          return
        }
        orgs.push(...retry)
      }
      const first = orgs[0]
      if (!first) return
      setOrg(first)
      setProjects(await listProjectsInOrg(first.id, signal))
    } catch (err) {
      if (signal?.aborted) return
      setError(
        err instanceof ApiFetchError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Could not load projects.',
      )
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const signedInAs = user
    ? user.displayName && user.displayName !== user.email
      ? `${user.displayName} · ${user.email}`
      : user.email
    : null

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{org?.name ?? 'Aiper'}</h1>
        <p className="page-sub">{signedInAs ? `Signed in as ${signedInAs}` : 'Not signed in'}</p>
      </header>

      {error && <div className="page-error">{error}</div>}

      <section className="page-section">
        <div className="page-section-label">Projects</div>
        {projects === null && !error ? (
          <p className="page-muted">Loading…</p>
        ) : (
          <>
            {projects && projects.length > 0 && (
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
            {projects && projects.length === 0 && (
              <p className="page-muted">No projects yet — create the first one below.</p>
            )}
            {org && (
              <CreateRow
                placeholder="New project name — e.g. MISSION-X"
                buttonLabel="Create project"
                onCreate={async (name) => {
                  await createProject(org.id, name)
                  await load()
                }}
              />
            )}
          </>
        )}
      </section>
    </div>
  )
}
