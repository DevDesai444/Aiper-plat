import { useSessionStore } from '../auth/sessionStore'

/**
 * PR-1b shell frame — brand on the left, user chip + sign-out on the right,
 * generous drag-strip in the middle. No Electron window controls (this is a
 * pure web build), and no per-document metadata yet — the editor will feed
 * filename / saved-at / dirty state into a slot here when E7's editor lands.
 */
export function TitleBar() {
  const user = useSessionStore((s) => s.user)
  const signOut = useSessionStore((s) => s.signOut)

  const initials = user
    ? user.displayName
        .split(/\s+/)
        .map((p) => p[0] ?? '')
        .slice(0, 2)
        .join('')
        .toUpperCase() || user.email[0]?.toUpperCase() || '?'
    : '?'

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-brand">AIPER</span>
      </div>
      <div className="titlebar-center" />
      <div className="titlebar-right">
        {user && (
          <button
            type="button"
            className="titlebar-avatar"
            title={`${
              user.displayName && user.displayName !== user.email
                ? `${user.displayName} · ${user.email}`
                : user.email
            } — click to sign out`}
            onClick={() => void signOut()}
          >
            {initials}
          </button>
        )}
      </div>
    </div>
  )
}
