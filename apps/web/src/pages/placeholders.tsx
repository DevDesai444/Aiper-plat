import { Link, useParams } from 'react-router-dom'
import './pages.css'

/**
 * Route placeholders for surfaces other engineers own. Kept in one file so
 * they are easy to delete or replace as those PRs land.
 *
 *   - ProductTreePlaceholder     (/p/:pid/tree)         — E9
 *   - CompatDashboardPlaceholder (/p/:pid/compat)       — E9
 *   - EditorPlaceholder          (/p/:pid/f/:fid/d/:did) — E7
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

export function EditorPlaceholder() {
  const { pid, fid, did } = useParams<{ pid: string; fid: string; did: string }>()
  return (
    <Placeholder
      title={`Document editor — ${did}`}
      owner="E7"
      back={{ to: `/p/${pid}/f/${fid}`, label: 'back to folder' }}
    />
  )
}
