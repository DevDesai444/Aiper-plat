import { createBrowserRouter } from 'react-router-dom'
import { RequireSession } from './RequireSession'
import { LoginPage } from '../pages/LoginPage'
import { DashboardPage } from '../pages/DashboardPage'
import { NotFoundPage } from '../pages/NotFoundPage'

/**
 * PR-1a route table. The full blueprint §6.1 map (`/orgs/:oid`, `/p/:pid`,
 * `/p/:pid/tree`, …) lands in PR-1b alongside the shell chrome. Keeping the
 * 1a table small keeps the guard/auth wiring the focus of this review.
 */
// Explicit annotation: React Router's returned Router type transitively
// references @remix-run/router internals that TS cannot name portably under
// `moduleResolution: "Bundler"`. `ReturnType<typeof …>` sidesteps the naming
// requirement without importing internal types.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireSession>
        <DashboardPage />
      </RequireSession>
    ),
  },
  { path: '*', element: <NotFoundPage /> },
])
