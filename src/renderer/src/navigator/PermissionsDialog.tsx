import { useEffect, useState, useCallback } from 'react'
import { X, ShieldCheck, Clock } from 'lucide-react'
import BlueprintCard from '../common/BlueprintCard'
import { api, type FolderMember, type PendingInvite } from '../api/client'
import { useFolderStore, type Access } from '../store/folderStore'
import { useToastStore } from '../common/toastStore'

const LEVELS: Array<{ value: Access; label: string; hint: string }> = [
  { value: 'viewer', label: 'Read only', hint: 'Open and read. Cannot propose changes.' },
  { value: 'editor', label: 'Can edit', hint: 'Edit and propose changes for review.' },
  { value: 'owner', label: 'Owner', hint: 'Everything an editor can do, plus accept changes and manage access.' }
]

/**
 * Who can see a project. You add an email address, not an account: the person may never have
 * opened Aiper. The invitation waits, and the first time anyone signs in with that address it
 * turns into real access automatically. There is no administrator anywhere in this screen —
 * the only authority over a project is its owners.
 */
export default function PermissionsDialog(): React.JSX.Element | null {
  const target = useFolderStore((s) => s.permissionsFor)
  const close = useFolderStore((s) => s.closePermissions)
  const refresh = useFolderStore((s) => s.refresh)
  const push = useToastStore((s) => s.push)

  const [members, setMembers] = useState<FolderMember[]>([])
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [addEmail, setAddEmail] = useState('')
  const [addAccess, setAddAccess] = useState<Access>('editor')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!target) return
    try {
      const [{ members }, { invites }] = await Promise.all([
        api.folderMembers(target.id),
        api.folderInvites(target.id)
      ])
      setMembers(members)
      setInvites(invites)
    } catch (err) {
      push(err instanceof Error ? err.message : 'Could not load who has access.', 'error')
    }
  }, [target, push])

  useEffect(() => {
    void load()
  }, [load])

  if (!target) return null

  const change = async (userId: string, access: Access | null): Promise<void> => {
    setBusy(true)
    try {
      await api.setFolderAccess(target.id, userId, access)
      await load()
      await refresh()
    } catch (err) {
      push(err instanceof Error ? err.message : 'Could not change access.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    const email = addEmail.trim()
    if (!email) return
    setBusy(true)
    try {
      const result = await api.inviteToFolder(target.id, email, addAccess)
      setAddEmail('')
      await load()
      await refresh()
      push(
        result.immediate
          ? `${email} now has access.`
          : `${email} is invited. They will see this project the first time they sign in.`,
        'info'
      )
    } catch (err) {
      push(err instanceof Error ? err.message : 'Could not add that person.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (email: string): Promise<void> => {
    setBusy(true)
    try {
      await api.revokeInvite(target.id, email)
      await load()
    } catch (err) {
      push(err instanceof Error ? err.message : 'Could not withdraw that invitation.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={close}>
      <BlueprintCard className="permissions-dialog" onClick={() => undefined}>
        <div className="permissions-head" onClick={(e) => e.stopPropagation()}>
          <div>
            <div className="permissions-kicker">People</div>
            <h2>{target.name}</h2>
          </div>
          <button type="button" onClick={close} aria-label="Close">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        <div onClick={(e) => e.stopPropagation()}>
          <div className="permissions-note">
            <ShieldCheck size={12} strokeWidth={1.5} />
            <span>Access carries down to every sub-folder and document inside.</span>
          </div>

          <table className="permissions-table">
            <tbody>
              {members.length === 0 && invites.length === 0 && (
                <tr>
                  <td colSpan={3} className="permissions-empty">
                    Nobody else has access yet.
                  </td>
                </tr>
              )}
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <div className="permissions-name">{m.displayName}</div>
                    <div className="permissions-email">{m.email}</div>
                  </td>
                  <td>
                    {m.inherited ? (
                      <span className="permissions-inherited" title="Granted on a parent folder">
                        {LEVELS.find((l) => l.value === m.access)?.label} · inherited
                      </span>
                    ) : (
                      <select
                        value={m.access}
                        disabled={busy}
                        onChange={(e) => void change(m.userId, e.target.value as Access)}
                      >
                        {LEVELS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="permissions-actions">
                    {!m.inherited && (
                      <button type="button" disabled={busy} onClick={() => void change(m.userId, null)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {invites.map((i) => (
                <tr key={i.email} className="permissions-pending">
                  <td>
                    <div className="permissions-name">
                      <Clock size={11} strokeWidth={1.5} /> Invited
                    </div>
                    <div className="permissions-email">{i.email}</div>
                  </td>
                  <td>
                    <span className="permissions-inherited">
                      {LEVELS.find((l) => l.value === i.access)?.label} · when they sign in
                    </span>
                  </td>
                  <td className="permissions-actions">
                    <button type="button" disabled={busy} onClick={() => void revoke(i.email)}>
                      Withdraw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="permissions-add">
            <input
              type="email"
              placeholder="email address or GitHub username"
              value={addEmail}
              disabled={busy}
              onChange={(e) => setAddEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
            />
            <select value={addAccess} disabled={busy} onChange={(e) => setAddAccess(e.target.value as Access)}>
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <button type="button" className="permissions-add-btn" disabled={!addEmail.trim() || busy} onClick={() => void add()}>
              Add
            </button>
          </div>

          <div className="permissions-legend">
            {LEVELS.map((l) => (
              <div key={l.value}>
                <strong>{l.label}</strong> — {l.hint}
              </div>
            ))}
          </div>
        </div>
      </BlueprintCard>
    </div>
  )
}
