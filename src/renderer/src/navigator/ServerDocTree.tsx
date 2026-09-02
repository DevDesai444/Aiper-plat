import { FileText, Lock, RefreshCw } from 'lucide-react'
import { useServerDocsStore } from '../store/serverDocsStore'
import { useSessionStore } from '../store/sessionStore'
import { useDocumentStore } from '../store/documentStore'
import { useUiStore } from '../store/uiStore'

export default function ServerDocTree(): React.JSX.Element {
  const documents = useServerDocsStore((s) => s.documents)
  const loading = useServerDocsStore((s) => s.loading)
  const error = useServerDocsStore((s) => s.error)
  const refresh = useServerDocsStore((s) => s.refresh)
  const me = useSessionStore((s) => s.user)
  const openDocumentId = useDocumentStore((s) => s.documentId)
  const requestOpenServerDoc = useDocumentStore((s) => s.requestOpenServerDoc)
  const dirty = useDocumentStore((s) => s.dirty)
  const setView = useUiStore((s) => s.setView)

  if (error) {
    return (
      <div className="navigator-empty">
        <p>{error}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    )
  }

  if (loading && documents.length === 0) return <div className="navigator-empty">Loading documents…</div>
  if (documents.length === 0) return <div className="navigator-empty">No documents yet</div>

  return (
    <div className="tree-list">
      {documents.map((doc) => {
        const lockedByMe = doc.lockedBy?.userId === me?.id
        const lockedByOther = doc.lockedBy && !lockedByMe
        const isOpen = openDocumentId === doc.id
        return (
          <div
            key={doc.id}
            className={`tree-row${isOpen ? ' is-selected' : ''}`}
            title={doc.lockedBy ? `Checked out by ${doc.lockedBy.displayName}` : doc.path}
            onClick={() => {
              if (dirty && !window.confirm('You have unsaved changes. Discard them and open this document?')) return
              setView('editor')
              requestOpenServerDoc(doc.id)
            }}
          >
            <span className="tree-caret-spacer" />
            <FileText size={13} strokeWidth={1.5} className="tree-icon" />
            <span className="tree-label">{doc.path}</span>
            <span className="tree-rev">v{doc.currentRevision}</span>
            {doc.lockedBy && (
              <Lock
                size={11}
                strokeWidth={1.5}
                className={lockedByOther ? 'tree-lock tree-lock--other' : 'tree-lock tree-lock--mine'}
              />
            )}
          </div>
        )
      })}
      <button type="button" className="tree-refresh" onClick={() => void refresh()}>
        <RefreshCw size={11} strokeWidth={1.5} />
        Refresh
      </button>
    </div>
  )
}
