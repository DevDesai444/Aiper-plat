import { useId, useState } from 'react'
import { Modal } from './Modal'
import { ApiFetchError } from '../api/client'
import './rowActions.css'

/**
 * Generic yes/no confirmation dialog. `danger` styles the confirm button
 * for destructive operations (delete, revoke). Uses the shared <Modal>.
 *
 * `onConfirm` is async and awaited; while it resolves the confirm button
 * disables and shows "Working…". A rejection surfaces inline and leaves
 * the dialog open so the user can retry or Cancel.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string
  message: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
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
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="modal-body">
        {error && <div className="row-dialog-error">{error}</div>}
        <div className="row-dialog-message">{message}</div>
        <div className="row-dialog-actions">
          <button type="button" className="row-dialog-btn" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`row-dialog-btn ${danger ? 'is-danger' : 'is-primary'}`}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function errText(err: unknown): string {
  if (err instanceof ApiFetchError) return err.message || 'Action failed.'
  if (err instanceof Error) return err.message
  return 'Action failed.'
}
