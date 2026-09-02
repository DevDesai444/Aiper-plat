import { create } from 'zustand'

/**
 * Mail merge state. The recipient list comes from a CSV the user picks — there is no address
 * book service behind this, so the data is whatever they supply and nothing is invented.
 */

export type MergeKind = 'Letters' | 'Envelopes' | 'Labels' | 'Directory'

export interface Recipient {
  [field: string]: string
}

interface MailingsState {
  fields: string[]
  recipients: Recipient[]
  /** Rows the user has excluded from the merge. */
  excluded: Set<number>
  kind: MergeKind
  /** Template body, stashed while previewing so the placeholders can be restored. */
  template: string | null
  previewIndex: number

  setRecipients: (fields: string[], recipients: Recipient[]) => void
  toggleExcluded: (index: number) => void
  setKind: (kind: MergeKind) => void
  beginPreview: (template: string) => void
  endPreview: () => void
  setPreviewIndex: (index: number) => void
  activeRecipients: () => Recipient[]
  clear: () => void
}

/**
 * Minimal RFC 4180 reader — handles quoted fields, embedded commas and doubled quotes,
 * which a naive split(',') gets wrong on real exported address lists.
 */
export function parseCsv(text: string): { fields: string[]; rows: Recipient[] } {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"'
          i++
        } else quoted = false
      } else value += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(value)
      value = ''
    } else if (ch === '\n') {
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else if (ch !== '\r') value += ch
  }
  if (value !== '' || row.length > 0) {
    row.push(value)
    rows.push(row)
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonEmpty.length === 0) return { fields: [], rows: [] }

  const fields = nonEmpty[0].map((f) => f.trim())
  const recipients = nonEmpty.slice(1).map((r) => {
    const rec: Recipient = {}
    fields.forEach((f, i) => {
      rec[f] = (r[i] ?? '').trim()
    })
    return rec
  })
  return { fields, rows: recipients }
}

/** Replaces «Field» placeholders with this recipient's values. Unknown fields are left alone. */
export function applyMerge(html: string, recipient: Recipient): string {
  return html.replace(/«([^»]+)»/g, (whole, field: string) => {
    const key = Object.keys(recipient).find((k) => k.toLowerCase() === field.trim().toLowerCase())
    return key ? recipient[key] : whole
  })
}

export const useMailingsStore = create<MailingsState>((set, get) => ({
  fields: [],
  recipients: [],
  excluded: new Set<number>(),
  kind: 'Letters',
  template: null,
  previewIndex: 0,

  setRecipients: (fields, recipients) => set({ fields, recipients, excluded: new Set(), previewIndex: 0 }),
  toggleExcluded: (index) =>
    set((s) => {
      const next = new Set(s.excluded)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return { excluded: next }
    }),
  setKind: (kind) => set({ kind }),
  beginPreview: (template) => set({ template, previewIndex: 0 }),
  endPreview: () => set({ template: null }),
  setPreviewIndex: (previewIndex) => set({ previewIndex }),
  activeRecipients: () => get().recipients.filter((_, i) => !get().excluded.has(i)),
  clear: () => set({ fields: [], recipients: [], excluded: new Set(), template: null, previewIndex: 0 })
}))
