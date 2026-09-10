import { useCallback, useEffect, useId, useState } from 'react'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'
import {
  grantPermission,
  listInvitations,
  listMembers,
  revokeInvitation,
  revokePermission,
  sendInvitation,
  type Invitation,
  type Member,
} from '../api/access'
import { ApiFetchError } from '../api/client'
import { Modal } from './Modal'
import './share.css'

const ROLES: AiperRole[] = ['viewer', 'editor', 'owner']

/**
 * Share dialog for a project / folder / document.
 *
 * Owner path:
 *   - Direct members: role dropdown (change role in-place) + remove button.
 *   - Inherited members: displayed read-only with a "from {parent}" tag —
 *     they are managed on the ancestor, not here.
 *   - Invite by email + role at the bottom.
 *   - Pending invitations: revoke button per row.
 *
 * Viewer/editor path: same lists, no controls.
 *
 * Every mutation refetches — simplest correctness story. Optimistic UI can
 * come later once we see it matter.
 *
 * When E2 ships the READ endpoints their 404-until-then response yields an
 * ApiFetchError which we surface inline; the write actions still work
 * against the already-live POST/DELETE routes.
 */
export function ShareDialog({
  subjectType,
  subjectId,
  subjectLabel,
  callerRole,
  onClose,
}: {
  subjectType: AiperSubject
  subjectId: string
  /** Human name for the header — "Mission profile", "Requirements", etc. */
  subjectLabel: string
  /** The caller's effective role on this subject. Only 'owner' enables writes. */
  callerRole: AiperRole | null
  onClose: () => void
}) {
  const titleId = useId()
  const isOwner = callerRole === 'owner'
  const [members, setMembers] = useState<Member[] | null>(null)
  const [invitations, setInvitations] = useState<Invitation[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Per-row errors keyed by userId / email so the 409 last-owner surfaces
   *  next to the row that caused it. */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const refetch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoadError(null)
      const results = await Promise.allSettled([
        listMembers(subjectType, subjectId, signal),
        listInvitations(subjectType, subjectId, signal),
      ])
      if (signal?.aborted) return

      const [memRes, invRes] = results
      if (memRes.status === 'fulfilled') setMembers(memRes.value)
      else setMembers([])
      if (invRes.status === 'fulfilled') setInvitations(invRes.value)
      else setInvitations([])

      // Only surface one error (member list is the primary signal); a
      // 404 here today means E2's READ route hasn't landed yet.
      if (memRes.status === 'rejected') {
        setLoadError(errText(memRes.reason, 'Could not load members.'))
      } else if (invRes.status === 'rejected') {
        setLoadError(errText(invRes.reason, 'Could not load invitations.'))
      }
    },
    [subjectType, subjectId],
  )

  useEffect(() => {
    const ac = new AbortController()
    void refetch(ac.signal)
    return () => ac.abort()
  }, [refetch])

  const runMutation = async (
    key: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    setBusyKey(key)
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    try {
      await fn()
      await refetch()
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [key]: errText(err, 'Action failed.'),
      }))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <Modal onClose={onClose} titleId={titleId}>
      <div className="modal-header">
        <div>
          <h2 id={titleId} className="modal-title">
            Share {subjectType}
          </h2>
          <p className="modal-sub">{subjectLabel}</p>
        </div>
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="modal-body">
        {loadError && <div className="share-error">{loadError}</div>}

        <section className="share-section">
          <div className="share-section-label">Members</div>
          {members === null ? (
            <p className="share-loading">Loading…</p>
          ) : members.length === 0 ? (
            <p className="share-empty">Nobody has access yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {members.map((m) => (
                <li key={m.userId}>
                  <div className="share-row">
                    <div className="share-row-main">
                      <span className="share-row-name">{m.displayName}</span>
                      <span className="share-row-sub">{m.email}</span>
                    </div>
                    {m.inherited ? (
                      <>
                        <span className="share-role-static">{m.role}</span>
                        <span
                          className="share-inherited-tag"
                          title={
                            m.source
                              ? `Inherited from a ${m.source.subjectType} above — manage there.`
                              : 'Inherited from an ancestor — manage there.'
                          }
                        >
                          Inherited
                        </span>
                      </>
                    ) : isOwner ? (
                      <>
                        <select
                          className="share-role"
                          value={m.role}
                          disabled={busyKey === `role:${m.userId}` || busyKey === `remove:${m.userId}`}
                          onChange={(e) =>
                            void runMutation(`role:${m.userId}`, () =>
                              grantPermission(
                                subjectType,
                                subjectId,
                                m.userId,
                                e.target.value as AiperRole,
                              ).then(() => undefined),
                            )
                          }
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="share-remove"
                          disabled={busyKey === `remove:${m.userId}` || busyKey === `role:${m.userId}`}
                          onClick={() =>
                            void runMutation(`remove:${m.userId}`, () =>
                              revokePermission(subjectType, subjectId, m.userId),
                            )
                          }
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <span className="share-role-static">{m.role}</span>
                    )}
                  </div>
                  {rowErrors[`role:${m.userId}`] && (
                    <div className="share-row-error">{rowErrors[`role:${m.userId}`]}</div>
                  )}
                  {rowErrors[`remove:${m.userId}`] && (
                    <div className="share-row-error">{rowErrors[`remove:${m.userId}`]}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {isOwner && (
          <section className="share-section">
            <div className="share-section-label">Invite by email</div>
            <InviteForm
              busy={busyKey === 'invite'}
              onSubmit={(email, role) =>
                runMutation('invite', () =>
                  sendInvitation(subjectType, subjectId, email, role).then(
                    () => undefined,
                  ),
                )
              }
            />
            {rowErrors['invite'] && (
              <div className="share-row-error">{rowErrors['invite']}</div>
            )}
          </section>
        )}

        <section className="share-section">
          <div className="share-section-label">Pending invitations</div>
          {invitations === null ? (
            <p className="share-loading">Loading…</p>
          ) : invitations.length === 0 ? (
            <p className="share-empty">No invitations pending.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {invitations.map((inv) => (
                <li key={inv.email}>
                  <div className="share-row">
                    <div className="share-row-main">
                      <span className="share-row-name">{inv.email}</span>
                      <span className="share-row-sub">
                        Invited {inv.invitedByName ? `by ${inv.invitedByName}` : ''}
                      </span>
                    </div>
                    <span className="share-role-static">{inv.role}</span>
                    {isOwner && (
                      <button
                        type="button"
                        className="share-remove"
                        disabled={busyKey === `inv:${inv.email}`}
                        onClick={() =>
                          void runMutation(`inv:${inv.email}`, () =>
                            revokeInvitation(subjectType, subjectId, inv.email),
                          )
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                  {rowErrors[`inv:${inv.email}`] && (
                    <div className="share-row-error">{rowErrors[`inv:${inv.email}`]}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}

function InviteForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (email: string, role: AiperRole) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AiperRole>('editor')

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || busy) return
    onSubmit(trimmed, role)
    setEmail('')
  }

  return (
    <form className="share-invite" onSubmit={handleSubmit}>
      <input
        type="email"
        placeholder="name@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
        required
      />
      <select
        className="share-role"
        value={role}
        onChange={(e) => setRole(e.target.value as AiperRole)}
        disabled={busy}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy || !email.trim()}>
        {busy ? 'Inviting…' : 'Invite'}
      </button>
    </form>
  )
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiFetchError) return err.message || fallback
  if (err instanceof Error) return err.message
  return fallback
}
