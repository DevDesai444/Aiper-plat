import { create } from 'zustand'

/**
 * In-app replacement for `window.prompt`.
 *
 * Electron does not implement `window.prompt` — it throws "prompt() is and will not be
 * supported". Every control that asked the user to name or type something therefore did
 * nothing at all: New project, New folder, New document, Link, Header, Footer, Comment, the
 * save summary, and most of the Insert/Layout/Design/References ribbon. The failure was silent
 * because the throw happened inside a click handler.
 *
 * `window.alert` and `window.confirm` are fine in Electron and are left alone.
 */
export type PromptKind = 'text' | 'lines' | 'number' | 'choice'

export interface PromptRequest {
  kind: PromptKind
  label: string
  /** Extra explanation under the label. */
  hint?: string
  initial: string
  options?: readonly string[]
  min?: number
  max?: number
  /** Label for the confirming button — "Create" reads better than "OK" on a naming dialog. */
  confirmLabel?: string
}

interface PromptState {
  request: (PromptRequest & { resolve: (value: string | null) => void }) | null
  open: (request: PromptRequest) => Promise<string | null>
  answer: (value: string | null) => void
}

export const usePromptStore = create<PromptState>((set, get) => ({
  request: null,

  open: (request) =>
    new Promise<string | null>((resolve) => {
      // A second prompt while one is open would strand the first promise, so cancel it first.
      const pending = get().request
      if (pending) pending.resolve(null)
      set({ request: { ...request, resolve } })
    }),

  answer: (value) => {
    const pending = get().request
    set({ request: null })
    pending?.resolve(value)
  }
}))

/** Free text with a default. Resolves null on cancel; empty string is a valid answer. */
export function askText(
  label: string,
  initial = '',
  opts: { hint?: string; confirmLabel?: string } = {}
): Promise<string | null> {
  return usePromptStore.getState().open({ kind: 'text', label, initial, ...opts })
}

/** Multi-line text, for things like chart data entered one row per line. */
export function askLines(label: string, initial = '', hint?: string): Promise<string | null> {
  return usePromptStore.getState().open({ kind: 'lines', label, initial, hint })
}

/** A number, clamped to the given bounds. Resolves null on cancel or a non-numeric answer. */
export async function askNumber(
  label: string,
  initial: number,
  min: number,
  max: number
): Promise<number | null> {
  const answer = await usePromptStore.getState().open({
    kind: 'number',
    label,
    initial: String(initial),
    min,
    max
  })
  if (answer === null) return null
  const n = Number(answer.trim())
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** Choose one of a fixed set. Resolves null on cancel. */
export async function pick<T extends string>(
  label: string,
  options: readonly T[],
  current?: T
): Promise<T | null> {
  const answer = await usePromptStore.getState().open({
    kind: 'choice',
    label,
    initial: current && options.includes(current) ? current : (options[0] ?? ''),
    options
  })
  return answer !== null && options.includes(answer as T) ? (answer as T) : null
}
