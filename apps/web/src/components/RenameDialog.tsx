import { useId, useState } from 'react'
import { Modal } from './Modal'
import { ApiFetchError } from '../api/client'
import './rowActions.css'

/**
 * Single-field rename dialog. Reuses the shared <Modal>. Server enforces
 * `editor+` on rename; the parent hides the trigger for lower roles so
 * this component doesn't re-check the role.
 */
export function RenameDialog({
  title,
  subjectLabel,
  initial,
  fieldLabel = 'Name',
  onSave,
  onClose,
}: {
  title: string
  subjectLabel: string
  initial: string
  fieldLabel?: string
  /** Returns the promise from the write call so the dialog can surface a
   *  server error inline (e.g. 403 from a race). Resolves the modal on
   *  fulfilment. */
  onSave: (next: string) => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const fieldId = useId()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || trimmed === initial || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(trimmed)
      onClose()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} titleId={titleId}>
      <div className="modal-header">
        <div>
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <p className="modal-sub">{subjectLabel}</p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <form className="modal-body" onSubmit={submit}>
        {error && <div className="row-dialog-error">{error}</div>}
        <label htmlFor={fieldId} className="row-dialog-label">
          {fieldLabel}
        </label>
        <input
          id={fieldId}
          className="row-dialog-input"
          type="text"
          value={value}
          autoFocus
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="row-dialog-actions">
          <button type="button" className="row-dialog-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="row-dialog-btn is-primary"
            disabled={busy || !value.trim() || value.trim() === initial}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function errText(err: unknown): string {
  if (err instanceof ApiFetchError) return err.message || 'Save failed.'
  if (err instanceof Error) return err.message
  return 'Save failed.'
}
