import { useCallback, useEffect, useState } from 'react'
import { Check, X, MessageSquare, AlertTriangle, RefreshCw, GitPullRequest } from 'lucide-react'
import { askText } from '../common/promptStore'
import { api, type Proposal, type ProposalReview, type ProposalComment } from '../api/client'
import { useDocumentStore } from '../store/documentStore'
import { useFolderStore } from '../store/folderStore'
import { useSessionStore } from '../store/sessionStore'
import { useToastStore } from '../common/toastStore'
import { useProposalStore } from '../store/proposalStore'

function DiffView({ review }: { review: ProposalReview }): React.JSX.Element {
  const changed = review.diff.blocks.filter((b) => b.status !== 'unchanged')
  if (changed.length === 0) return <div className="proposal-nochange">No changes against the current version.</div>
  return (
    <div className="proposal-diff">
      {changed.map((b, i) => (
        <div key={i} className={`proposal-diff-block proposal-diff-block--${b.status}`}>
          {b.words.map((w, j) =>
            w.kind === 'added' ? (
              <ins key={j}>{w.text}</ins>
            ) : w.kind === 'removed' ? (
              <del key={j}>{w.text}</del>
            ) : (
              <span key={j}>{w.text}</span>
            )
          )}
        </div>
      ))}
      <div className="proposal-diff-summary">
        +{review.diff.summary.wordsAdded} / −{review.diff.summary.wordsRemoved} words
      </div>
    </div>
  )
}

/**
 * Whether the signed-in user owns the project this proposal belongs to.
 *
 * Only owners resolve proposals — that is the whole point of proposing rather than saving. The
 * document id carries its project ("owner/repo:path"), so the answer comes from the folder tree
 * without another API call.
 *
 * Worth being precise about what this is: it hides the buttons, it does not enforce the rule.
 * GitHub's write permission permits merging a pull request, so an editor determined to bypass
 * review could still do it through github.com. Enforcing it properly needs a branch protection
 * rule requiring review on the default branch, which on private repositories is a paid feature.
 */
function useIsProjectOwner(documentId: string): boolean {
  const folders = useFolderStore((s) => s.folders)
  const repo = documentId.split(':')[0]
  return folders.some((f) => f.id === repo && f.access === 'owner')
}

function ProposalCard({ p, onChanged }: { p: Proposal; onChanged: () => void }): React.JSX.Element {
  const canResolve = useIsProjectOwner(p.documentId)
  const me = useSessionStore((s) => s.user)
  const push = useToastStore((s) => s.push)
  const [review, setReview] = useState<ProposalReview | null>(null)
  const [comments, setComments] = useState<ProposalComment[]>([])
  const [showDiscuss, setShowDiscuss] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setReview(await api.reviewProposal(p.id))
      const { comments } = await api.proposalComments(p.id)
      setComments(comments)
    } catch {
      /* the list will show the error state */
    }
  }, [p.id])

  useEffect(() => {
    void load()
  }, [load, p.updatedAt])

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      push(done)
      onChanged()
    } catch (err) {
      push(err instanceof Error ? err.message : 'Action failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const isMine = p.authorId === me?.id
  const open = p.status === 'open'

  return (
    <div className={`proposal-card proposal-card--${p.status}`}>
      <div className="proposal-head">
        <GitPullRequest size={13} strokeWidth={1.5} />
        <span className="proposal-author">{p.authorName}</span>
        {isMine && <span className="proposal-you">you</span>}
        <span className={`proposal-status proposal-status--${p.status}`}>{p.status}</span>
      </div>

      {p.summary && <div className="proposal-summary">{p.summary}</div>}

      {p.stale && open && (
        <div className="proposal-stale">
          <AlertTriangle size={12} strokeWidth={1.5} />
          <span>
            Written against v{p.baseRevision}; the document has moved on.
            {review?.conflicts?.length ? ' It now conflicts — see below.' : ' It still applies cleanly.'}
          </span>
        </div>
      )}

      {review && <DiffView review={review} />}

      {review?.conflicts?.map((c, i) => (
        <div key={i} className="proposal-conflict">
          <div className="proposal-conflict-title">Conflicting change — choose one</div>
          <div>
            <em>was</em> {c.base}
          </div>
          <div>
            <em>this proposal</em> {c.ours}
          </div>
          <div>
            <em>current</em> {c.theirs}
          </div>
        </div>
      ))}

      {p.status !== 'open' && (
        <div className="proposal-resolved">
          {/* Only name a person or a revision when one is actually known — printing "null"
              at the user is worse than saying less. */}
          {p.status === 'accepted'
            ? [
                'Accepted',
                p.resolvedByName ? `by ${p.resolvedByName}` : null,
                p.resultingRevision ? `as v${p.resultingRevision}` : null
              ]
                .filter(Boolean)
                .join(' ')
            : ['Closed', p.resolvedByName ? `by ${p.resolvedByName}` : null].filter(Boolean).join(' ')}
        </div>
      )}

      <div className="proposal-actions">
        <button type="button" onClick={() => setShowDiscuss((v) => !v)}>
          <MessageSquare size={12} strokeWidth={1.5} />
          Discuss{p.commentCount > 0 ? ` (${p.commentCount})` : ''}
        </button>
        {open && !canResolve && <span className="proposal-awaiting">Waiting for an owner to review</span>}
        {open && canResolve && (
          <>
            <button
              type="button"
              className="proposal-accept"
              disabled={busy}
              onClick={async () => {
                const reason = await askText('Reason for accepting', '', {
                  hint: 'Optional — it is recorded in the audit trail against this revision.',
                  confirmLabel: 'Accept'
                })
                // Cancelling the dialog cancels the acceptance; an empty answer accepts with
                // no reason. Treating cancel as "accept anyway" would make a mis-click final.
                if (reason === null) return
                await act(async () => {
                  await api.acceptProposal(p.id, reason.trim() || null)
                  // Accepting changes the document under whoever is reading it, including the
                  // person who just clicked. They get no "someone saved" prompt — that is
                  // suppressed for your own saves — so reopen it for them.
                  if (useDocumentStore.getState().documentId === p.documentId) {
                    useDocumentStore.getState().requestOpenServerDoc(p.documentId)
                  }
                }, 'Accepted')
              }}
            >
              <Check size={12} strokeWidth={1.5} />
              Accept
            </button>
            <button
              type="button"
              className="proposal-close"
              disabled={busy}
              onClick={async () => {
                const reason = await askText('Reason for closing', '', {
                  hint: 'Optional — the author sees it, and it is recorded in the audit trail.',
                  confirmLabel: 'Close proposal'
                })
                if (reason === null) return
                await act(() => api.closeProposal(p.id, reason.trim() || null), 'Closed')
              }}
            >
              <X size={12} strokeWidth={1.5} />
              Close
            </button>
          </>
        )}
      </div>

      {showDiscuss && (
        <div className="proposal-discuss">
          {comments.length === 0 && <div className="proposal-nochange">No comments yet.</div>}
          {comments.map((c) => (
            <div key={c.id} className="proposal-comment">
              <span className="proposal-comment-author">{c.authorName}</span>
              <span>{c.body}</span>
            </div>
          ))}
          <div className="proposal-comment-add">
            <input
              value={draft}
              placeholder="Add a comment…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  const body = draft.trim()
                  setDraft('')
                  void act(() => api.addProposalComment(p.id, body), 'Comment added').then(load)
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default function ProposalsPanel(): React.JSX.Element {
  const documentId = useDocumentStore((s) => s.documentId)
  const proposals = useProposalStore((s) => s.proposals)
  const loading = useProposalStore((s) => s.loading)
  const refresh = useProposalStore((s) => s.refresh)

  useEffect(() => {
    if (documentId) void refresh(documentId)
  }, [documentId, refresh])

  if (!documentId) return <div className="navigator-empty">Open a document to see its proposals.</div>
  if (loading && proposals.length === 0) return <div className="navigator-empty">Loading…</div>

  return (
    <div className="proposals-panel">
      <div className="audit-toolbar">
        <span className="audit-section-title" style={{ margin: 0 }}>
          Change proposals
        </span>
        <button type="button" className="audit-icon-btn" onClick={() => void refresh(documentId)}>
          <RefreshCw size={12} strokeWidth={1.5} />
        </button>
      </div>
      {proposals.length === 0 && (
        <div className="navigator-empty">
          <p>No proposals.</p>
          <p className="navigator-empty-hint">Editing and saving raises one for review.</p>
        </div>
      )}
      {proposals.map((p) => (
        <ProposalCard key={p.id} p={p} onChanged={() => void refresh(documentId)} />
      ))}
    </div>
  )
}
