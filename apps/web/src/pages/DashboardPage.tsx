import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Organization } from '@aiper/shared/types'
import { listOrgs } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import { useSessionStore } from '../auth/sessionStore'
import './pages.css'

/**
 * Landing page after sign-in. Lists the caller's organizations; clicking one
 * jumps to /orgs/:oid where the project list lives. A one-hop indirection —
 * flattening orgs + projects onto Dashboard would need a fetch per org and
 * hides how the hierarchy actually walks.
 */
export function DashboardPage() {
  const user = useSessionStore((s) => s.user)
  const [orgs, setOrgs] = useState<Organization[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    listOrgs(ac.signal)
      .then(setOrgs)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(
          err instanceof ApiFetchError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Could not load organizations.',
        )
      })
    return () => ac.abort()
  }, [])

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">
          {user ? `Signed in as ${user.displayName} <${user.email}>` : 'Not signed in'}
        </p>
      </header>

      <section className="page-section">
        <div className="page-section-label">Organizations</div>
        {error ? (
          <div className="page-error">{error}</div>
        ) : orgs === null ? (
          <p className="page-muted">Loading…</p>
        ) : orgs.length === 0 ? (
          <p className="page-muted">You are not a member of any organizations yet.</p>
        ) : (
          <div className="card-list">
            {orgs.map((org) => (
              <Link key={org.id} to={`/orgs/${org.id}`} className="card">
                <span className="card-title">{org.name}</span>
                <span className="card-sub">{org.slug}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
