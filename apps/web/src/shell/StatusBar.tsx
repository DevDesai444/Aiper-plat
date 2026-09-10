import { useEffect, useState } from 'react'
import { Circle } from 'lucide-react'
import { useSessionStore } from '../auth/sessionStore'
import { getHealth, type Health } from '../api/endpoints'
import { ApiFetchError } from '../api/client'

/**
 * Bottom bar. Two live indicators for PR-1b: server reachability (from a
 * one-shot /health probe on mount) and the signed-in user's email. Everything
 * else the legacy StatusBar carried — word count, zoom, track-changes,
 * findings badge — is editor / compat state and will be filled by E7 / E9.
 */
export function StatusBar() {
  const user = useSessionStore((s) => s.user)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthy, setHealthy] = useState<boolean | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getHealth(ac.signal)
      .then((h) => {
        setHealth(h)
        setHealthy(true)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        // 503 comes back as an ApiFetchError with code:'malformed' — good
        // enough to flag the server as down without dedicated handling.
        setHealth(null)
        setHealthy(err instanceof ApiFetchError ? false : false)
      })
    return () => ac.abort()
  }, [])

  return (
    <div className="statusbar">
      <span className="statusbar-track" title={healthy ? 'Server reachable' : 'Server offline'}>
        <Circle
          size={7}
          fill={healthy ? '#749dc4' : 'transparent'}
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {healthy === null
          ? 'Checking…'
          : healthy
            ? `Server v${health?.version ?? ''}`
            : 'Server offline'}
      </span>
      <span className="statusbar-spacer" />
      {user && <span className="statusbar-user">{user.email}</span>}
    </div>
  )
}
