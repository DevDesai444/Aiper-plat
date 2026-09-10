import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X, FileText, Search } from 'lucide-react'
import logo from '../assets/aiper-logo.png'
import { useDocumentStore } from '../store/documentStore'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import { useToastStore } from '../common/toastStore'

export default function TitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const fileName = useDocumentStore((s) => s.fileName)
  const savedAt = useDocumentStore((s) => s.savedAt)
  const dirty = useDocumentStore((s) => s.dirty)
  const revision = useDocumentStore((s) => s.revision)
  const user = useSessionStore((s) => s.user)
  const signOut = useSessionStore((s) => s.signOut)
  const requestSearch = useUiStore((s) => s.requestSearch)
  const setView = useUiStore((s) => s.setView)
  const push = useToastStore((s) => s.push)

  // macOS draws its own traffic lights inset into this bar, so the renderer must not
  // add a second set — it only draws window controls on Windows/Linux.
  const isMac = window.aiper?.platform === 'darwin'

  useEffect(() => {
    if (!window.aiper) return
    window.aiper.window.isMaximized().then(setIsMaximized)
    return window.aiper.window.onMaximizeChanged(setIsMaximized)
  }, [])

  return (
    <div className={`titlebar${isMac ? ' titlebar--mac' : ''}`}>
      <div className="titlebar-drag titlebar-left">
        <img src={logo} alt="Aiper" className="titlebar-logo" />
        <div className="titlebar-divider" />
        <span className="titlebar-wordmark">AIPER</span>
      </div>

      <div className="titlebar-drag titlebar-center">
        {fileName && (
          <>
            <FileText size={13} strokeWidth={1.5} className="titlebar-file-icon" />
            <span className="titlebar-filename">{fileName}</span>
            {revision > 0 && <span className="titlebar-saved-badge">v{revision}</span>}
            {savedAt && !dirty && <span className="titlebar-saved-badge">Saved {savedAt}</span>}
            {dirty && <span className="titlebar-saved-badge titlebar-saved-badge--dirty">Unsaved</span>}
          </>
        )}
      </div>

      <div className="titlebar-right">
        <button
          className="titlebar-search-btn"
          type="button"
          title="Search this document (Ctrl/Cmd-F)"
          onClick={() => {
            // Search only means anything against an open document; sending the user to a
            // find bar that cannot exist yet is worse than saying so.
            if (!fileName) {
              push('Open a document first — search looks inside the document you are editing.', 'warn')
              return
            }
            setView('editor')
            requestSearch()
          }}
        >
          <Search size={13} strokeWidth={1.5} />
          <span>Search</span>
        </button>
        {user && (
          <button
            type="button"
            className="titlebar-avatar"
            title={`${user.displayName} — ${user.email}\nClick to sign out`}
            onClick={() => void signOut()}
          >
            {user.displayName
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </button>
        )}
        {!isMac && (
          <div className="titlebar-winctl">
            <button type="button" aria-label="Minimize" onClick={() => window.aiper.window.minimize()}>
              <Minus size={13} strokeWidth={1.5} />
            </button>
            <button type="button" aria-label="Maximize" onClick={() => window.aiper.window.maximizeToggle()}>
              {isMaximized ? <Copy size={11} strokeWidth={1.5} /> : <Square size={11} strokeWidth={1.5} />}
            </button>
            <button
              type="button"
              aria-label="Close"
              className="titlebar-winctl-close"
              onClick={() => window.aiper.window.close()}
            >
              <X size={13} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
