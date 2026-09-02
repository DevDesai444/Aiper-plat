import { useEffect, useRef, useState } from 'react'
import BlueprintCard from './BlueprintCard'
import { usePromptStore } from './promptStore'

/**
 * The single dialog behind every ask in the app. Mounted once in App; opened through the
 * helpers in promptStore rather than by rendering it anywhere.
 */
export default function PromptDialog(): React.JSX.Element | null {
  const request = usePromptStore((s) => s.request)
  const answer = usePromptStore((s) => s.answer)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  // Reset to the requested default whenever a new prompt opens, and take focus so the dialog
  // can be answered without reaching for the mouse.
  useEffect(() => {
    if (!request) return
    setValue(request.initial)
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      if (inputRef.current instanceof HTMLInputElement) inputRef.current.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [request])

  if (!request) return null

  const cancel = (): void => answer(null)

  // A real form so Enter confirms natively from the input — a keydown handler is one more
  // thing that can silently not fire, which is the bug this whole dialog exists to fix. A
  // textarea does not submit its form on Enter, which is exactly right for multi-line input.
  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    answer(value)
  }

  // Enter is handled explicitly rather than left to the form's implicit submission. Implicit
  // submission is a *default action* of the keypress, so it does not fire for programmatically
  // dispatched keys — which makes it untestable, and untestable is how the window.prompt bug
  // survived. Answering twice is harmless: the second call finds nothing pending.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
      return
    }
    if (e.key !== 'Enter') return
    // In a textarea Enter inserts a newline; Cmd/Ctrl-Enter confirms.
    if (request.kind === 'lines' && !(e.metaKey || e.ctrlKey)) return
    e.preventDefault()
    answer(value)
  }

  return (
    <div className="dialog-backdrop" onClick={cancel}>
      <BlueprintCard className="prompt-dialog" onClick={() => undefined}>
        <form onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown} onSubmit={onSubmit}>
          <label className="prompt-label" htmlFor="prompt-input">
            {request.label}
          </label>
          {request.hint && <p className="prompt-hint">{request.hint}</p>}

          {request.kind === 'choice' ? (
            <select
              id="prompt-input"
              ref={inputRef as React.RefObject<HTMLSelectElement>}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              {request.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : request.kind === 'lines' ? (
            <textarea
              id="prompt-input"
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              rows={7}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <input
              id="prompt-input"
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={request.kind === 'number' ? 'number' : 'text'}
              min={request.min}
              max={request.max}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}

          <div className="prompt-actions">
            <button type="button" className="prompt-cancel" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="prompt-confirm">
              {request.confirmLabel ?? 'OK'}
            </button>
          </div>
        </form>
      </BlueprintCard>
    </div>
  )
}
