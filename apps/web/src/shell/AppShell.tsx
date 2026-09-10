import { Outlet } from 'react-router-dom'
import { TitleBar } from './TitleBar'
import { TabBar } from './TabBar'
import { Ribbon } from './Ribbon'
import { Navigator } from './Navigator'
import { Dock } from './Dock'
import { StatusBar } from './StatusBar'
import './shell.css'

/**
 * Layout wrapper for every authenticated route. Grid:
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ TitleBar                                      │
 *   ├───────────────────────────────────────────────┤
 *   │ TabBar                                        │
 *   ├───────────────────────────────────────────────┤
 *   │ Ribbon (collapsible)                          │
 *   ├──────────┬────────────────────────┬───────────┤
 *   │ Navigator│  <Outlet/>  (page)     │ Dock      │
 *   ├──────────┴────────────────────────┴───────────┤
 *   │ StatusBar                                     │
 *   └───────────────────────────────────────────────┘
 *
 * `<Outlet/>` renders the routed page (Dashboard / Org / Project / Folder /
 * placeholders for editor / tree / compat).
 */
export function AppShell() {
  return (
    <div className="app-shell">
      <TitleBar />
      <TabBar />
      <Ribbon />
      <div className="app-body">
        <Navigator />
        <main className="app-center">
          <Outlet />
        </main>
        <Dock />
      </div>
      <StatusBar />
    </div>
  )
}
