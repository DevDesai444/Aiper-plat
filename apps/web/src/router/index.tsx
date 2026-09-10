import { createBrowserRouter } from 'react-router-dom'
import { RequireSession } from './RequireSession'
import { AppShell } from '../shell/AppShell'
import { LoginPage } from '../pages/LoginPage'
import { DashboardPage } from '../pages/DashboardPage'
import { OrgOverviewPage } from '../pages/OrgOverviewPage'
import { ProjectOverviewPage } from '../pages/ProjectOverviewPage'
import { FolderViewPage } from '../pages/FolderViewPage'
import { SettingsPage } from '../pages/SettingsPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import {
  ProductTreePlaceholder,
  CompatDashboardPlaceholder,
  EditorPlaceholder,
} from '../pages/placeholders'

/**
 * Full blueprint §6.1 route map. Every authenticated route renders inside
 * `<AppShell/>` — the shell's `<Outlet/>` fills the center pane. `/login`
 * lives outside the shell so a signed-out user does not briefly see chrome
 * they cannot use.
 *
 * Explicit annotation on `router` — React Router's returned type transitively
 * references @remix-run/router internals that TS cannot name portably under
 * `moduleResolution: "Bundler"`. `ReturnType<typeof …>` sidesteps that
 * without importing internal types.
 */
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'orgs/:oid', element: <OrgOverviewPage /> },
      { path: 'p/:pid', element: <ProjectOverviewPage /> },
      { path: 'p/:pid/tree', element: <ProductTreePlaceholder /> },
      { path: 'p/:pid/compat', element: <CompatDashboardPlaceholder /> },
      { path: 'p/:pid/f/:fid', element: <FolderViewPage /> },
      { path: 'p/:pid/f/:fid/d/:did', element: <EditorPlaceholder /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
])
