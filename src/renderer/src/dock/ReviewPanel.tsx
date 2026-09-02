import { useTrackChangesStore } from '../store/trackChangesStore'
import { useCommentStore } from '../store/commentStore'
import { useDocumentStore } from '../store/documentStore'

export default function ReviewPanel(): React.JSX.Element {
  const changes = useTrackChangesStore((s) => s.changes)
  const acceptChange = useTrackChangesStore((s) => s.acceptChange)
  const rejectChange = useTrackChangesStore((s) => s.rejectChange)
  const trackChangesEnabled = useDocumentStore((s) => s.trackChangesEnabled)
  const comments = useCommentStore((s) => s.comments)
  const resolveComment = useCommentStore((s) => s.resolveComment)
  const removeComment = useCommentStore((s) => s.removeComment)

  return (
    <div className="review-panel">
      <div className="review-panel-status">
        Track changes is <strong>{trackChangesEnabled ? 'on' : 'off'}</strong> — toggle it from the Review ribbon tab.
      </div>

      {changes.length === 0 && comments.length === 0 && <div className="navigator-empty">No pending changes or comments</div>}

      {changes.map((c) => (
        <div key={c.id} className="review-change">
          <div className="review-change-head">
            <span className={`review-change-kind review-change-kind--${c.kind}`}>{c.kind}</span>
            <span className="review-change-author">{c.authorName}</span>
          </div>
          <div className="review-change-text">{c.text}</div>
          <div className="review-change-actions">
            <button type="button" onClick={() => acceptChange(c.id)}>
              Accept
            </button>
            <button type="button" onClick={() => rejectChange(c.id)}>
              Reject
            </button>
          </div>
        </div>
      ))}

      {comments.map((c) => (
        <div key={c.id} className={`review-change${c.resolved ? ' is-resolved' : ''}`}>
          <div className="review-change-head">
            <span className="review-change-kind review-change-kind--comment">comment</span>
            <span className="review-change-author">{c.authorName}</span>
          </div>
          <div className="review-change-text">"{c.quotedText}"</div>
          <div className="review-change-text">{c.body}</div>
          <div className="review-change-actions">
            {!c.resolved && (
              <button type="button" onClick={() => void resolveComment(c.id)}>
                Resolve
              </button>
            )}
            <button type="button" onClick={() => void removeComment(c.id)}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
