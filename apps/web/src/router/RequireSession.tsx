import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useSessionStore } from '../auth/sessionStore'

/**
 * Route guard: while the store is still checking (`unknown`) render a neutral
 * loading pane, on `signed-out` redirect to /login preserving the current
 * URL, on `signed-in` render children.
 *
 * The Supabase subscription that drives `status` is installed once at the
 * top of the app (see App.tsx). This guard does not install its own —
 * multiple instances would multiply subscriptions.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const status = useSessionStore((s) => s.status)
  const location = useLocation()

  if (status === 'unknown') {
    return <div className="page-loading">Loading…</div>
  }
  if (status === 'signed-out') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}
