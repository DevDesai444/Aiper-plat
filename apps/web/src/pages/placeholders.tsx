import { Link, useParams } from 'react-router-dom'
import './pages.css'

/**
 * Route placeholders for surfaces other engineers own. Kept in one file so
 * they are easy to delete or replace as those PRs land.
 *
 *   - ProductTreePlaceholder     (/p/:pid/tree)   — E9
 *   - CompatDashboardPlaceholder (/p/:pid/compat) — E9
 *
 * The editor placeholder was replaced by `apps/web/src/editor/EditorPage.tsx`
 * in the E7 PR-1 landing; the routes are `/p/:pid/f/:fid/d/:did` and
 * `/p/:pid/d/:did`.
 */

function Placeholder({ title, owner, back }: { title: string; owner: string; back?: { to: string; label: string } }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">Coming in a later PR — owned by {owner}</p>
      </header>
      {back && (
        <p>
          <Link to={back.to}>{back.label}</Link>
        </p>
      )}
    </div>
  )
}

export function ProductTreePlaceholder() {
  const { pid } = useParams<{ pid: string }>()
  return (
    <Placeholder
      title="Product tree"
      owner="E9"
      back={{ to: `/p/${pid}`, label: 'back to project' }}
    />
  )
}

export function CompatDashboardPlaceholder() {
  const { pid } = useParams<{ pid: string }>()
  return (
    <Placeholder
      title="Compatibility dashboard"
      owner="E9"
      back={{ to: `/p/${pid}`, label: 'back to project' }}
    />
  )
}
