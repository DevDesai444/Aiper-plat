import { Link } from 'react-router-dom'
import './pages.css'

export function NotFoundPage() {
  return (
    <div className="centered-page">
      <div className="notfound">
        <p className="notfound-code">404</p>
        <p>Nothing at that path.</p>
        <p>
          <Link to="/">Back to dashboard</Link>
        </p>
      </div>
    </div>
  )
}
