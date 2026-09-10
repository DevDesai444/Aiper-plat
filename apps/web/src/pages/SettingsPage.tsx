import { useSessionStore } from '../auth/sessionStore'
import './pages.css'

/**
 * PR-1b placeholder settings page. A real profile / preferences surface
 * arrives once we have anything worth preferring; today it is a signed-in
 * confirmation + sign-out.
 */
export function SettingsPage() {
  const user = useSessionStore((s) => s.user)
  const signOut = useSessionStore((s) => s.signOut)

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>

      {user && (
        <>
          <section className="page-section">
            <div className="page-section-label">Signed in as</div>
            <p>
              {user.displayName} &lt;{user.email}&gt;
            </p>
          </section>

          <section className="page-section">
            <div className="page-section-label">Session</div>
            <button
              type="button"
              className="login-submit"
              style={{ width: 'auto', padding: '8px 20px' }}
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </section>
        </>
      )}
    </div>
  )
}
