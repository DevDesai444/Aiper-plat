import { useEffect, useState } from 'react'
import { useSessionStore } from '../auth/sessionStore'
import { getHealth, type Health } from '../api/endpoints'
import { ApiFetchError } from '../api/client'
import './pages.css'

/**
 * PR-1a landing page. Exists only to prove auth end-to-end:
 *   1. `/api/v1/me` was hit by the sessionStore during hydration (user is here)
 *   2. `/api/v1/health` is hit on mount (public endpoint — no bearer needed
 *      but a good smoke test of the fetch wrapper and dev proxy)
 * PR-1b replaces this with the real dashboard rail.
 */
export function DashboardPage() {
  const user = useSessionStore((s) => s.user)
  const signOut = useSessionStore((s) => s.signOut)

  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getHealth(ac.signal)
      .then(setHealth)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setHealthError(
          err instanceof ApiFetchError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Could not reach the server.',
        )
      })
    return () => ac.abort()
  }, [])

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div>
          <h1 className="dashboard-title">Dashboard</h1>
          <p className="dashboard-sub">PR-1a scaffold — real UI lands in PR-1b</p>
        </div>
        <button type="button" className="dashboard-signout" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>

      <section className="dashboard-section">
        <div className="dashboard-section-label">Signed in as</div>
        <div className="dashboard-value">
          {user ? (
            <>
              {user.displayName} &lt;{user.email}&gt;
            </>
          ) : (
            <span className="dashboard-muted">No user hydrated</span>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <div className="dashboard-section-label">Org memberships</div>
        <div className="dashboard-value">
          {user && user.orgMemberships.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {user.orgMemberships.map((m) => (
                <li key={m.orgId}>
                  {m.orgId} — {m.role}
                </li>
              ))}
            </ul>
          ) : (
            <span className="dashboard-muted">None yet</span>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <div className="dashboard-section-label">Server health</div>
        {healthError ? (
          <div className="dashboard-error">{healthError}</div>
        ) : health ? (
          <div className="dashboard-value">
            {health.service} v{health.version} — ok
          </div>
        ) : (
          <div className="dashboard-muted">Checking…</div>
        )}
      </section>
    </div>
  )
}
