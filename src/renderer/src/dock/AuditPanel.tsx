import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, RefreshCw, History } from 'lucide-react'
import { api, type AuditEntry } from '../api/client'
import { useDocumentStore } from '../store/documentStore'

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'auth.account_locked': 'Account locked',
  'document.created': 'Created document',
  'document.opened': 'Opened document',
  'document.saved': 'Saved revision',
  'document.checked_out': 'Checked out',
  'document.checked_in': 'Checked in',
  'document.lock_forced': 'Forced check-in'
}

export default function AuditPanel(): React.JSX.Element {
  const documentId = useDocumentStore((s) => s.documentId)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [history, setHistory] = useState<Array<{ revision: number; authorName: string; createdAt: string }>>([])
  const [chain, setChain] = useState<{ ok: boolean; checked: number; detail: string } | null>(null)
  const [scope, setScope] = useState<'document' | 'all'>('document')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const { entries } = await api.audit(scope === 'document' && documentId ? documentId : undefined)
      setEntries(entries)
      if (documentId) {
        const { history } = await api.history(documentId)
        setHistory(history)
      } else {
        setHistory([])
      }
    } catch {
      setEntries([])
    } finally {
      setBusy(false)
    }
  }, [documentId, scope])

  useEffect(() => {
    void load()
  }, [load])

  const verify = async (): Promise<void> => {
    setChain(null)
    try {
      setChain(await api.verifyAudit())
    } catch {
      setChain({ ok: false, checked: 0, detail: 'Could not reach the server.' })
    }
  }

  return (
    <div className="audit-panel">
      <div className="audit-toolbar">
        <div className="navigator-tabtoggle">
          <button type="button" className={scope === 'document' ? 'is-active' : ''} onClick={() => setScope('document')}>
            This doc
          </button>
          <button type="button" className={scope === 'all' ? 'is-active' : ''} onClick={() => setScope('all')}>
            All
          </button>
        </div>
        <button type="button" className="audit-icon-btn" onClick={() => void load()} title="Refresh">
          <RefreshCw size={12} strokeWidth={1.5} />
        </button>
      </div>

      {/* Chain verification is the control that actually demonstrates 11.10(e) integrity —
          it belongs in the UI, not only in a test. */}
      <button type="button" className="audit-verify-btn" onClick={() => void verify()}>
        <ShieldCheck size={13} strokeWidth={1.5} />
        Verify audit integrity
      </button>
      {chain && (
        <div className={`audit-chain ${chain.ok ? 'audit-chain--ok' : 'audit-chain--broken'}`}>
          {chain.ok ? <ShieldCheck size={13} strokeWidth={1.5} /> : <ShieldAlert size={13} strokeWidth={1.5} />}
          <span>{chain.detail}</span>
        </div>
      )}

      {history.length > 0 && (
        <>
          <div className="audit-section-title">
            <History size={11} strokeWidth={1.5} /> Version history
          </div>
          <div className="audit-history">
            {history.map((h) => (
              <div key={h.revision} className="audit-history-row">
                <span className="audit-rev">v{h.revision}</span>
                <span className="audit-author">{h.authorName}</span>
                <span className="audit-time">{new Date(h.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="audit-section-title">Audit trail</div>
      {busy && entries.length === 0 && <div className="navigator-empty">Loading…</div>}
      {!busy && entries.length === 0 && <div className="navigator-empty">No audit records</div>}
      <div className="audit-entries">
        {entries.map((e) => (
          <div key={e.id} className="audit-entry">
            <div className="audit-entry-head">
              <span className="audit-entry-action">{ACTION_LABELS[e.action] ?? e.action}</span>
              <span className="audit-time">{new Date(e.occurred_at).toLocaleTimeString()}</span>
            </div>
            <div className="audit-entry-meta">
              {e.printed_name}
              {e.revision_after != null && ` · v${e.revision_before ?? '—'} → v${e.revision_after}`}
            </div>
            {e.reason && <div className="audit-entry-reason">“{e.reason}”</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
