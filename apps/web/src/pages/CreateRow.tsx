import { useState } from 'react'
import { ApiFetchError } from '../api/client'
import './pages.css'

/**
 * One-line inline create form: text input + button. Used for "new project",
 * "new folder", "new document" — anywhere a single name is all the server
 * needs. Owns its busy/error state; the parent passes an async onCreate
 * that throws on failure (ApiFetchError surfaces its server message).
 */
export function CreateRow({
  placeholder,
  buttonLabel,
  onCreate,
}: {
  placeholder: string
  buttonLabel: string
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed)
      setName('')
    } catch (err) {
      setError(
        err instanceof ApiFetchError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Create failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="create-block">
      <form
        className="create-row"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          type="text"
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : buttonLabel}
        </button>
      </form>
      {error && <div className="create-error">{error}</div>}
    </div>
  )
}
