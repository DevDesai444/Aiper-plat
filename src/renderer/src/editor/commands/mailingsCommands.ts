import type { Editor } from '@tiptap/core'
import { useMailingsStore, parseCsv, applyMerge, type MergeKind } from '../../store/mailingsStore'
import { useDocumentStore } from '../../store/documentStore'
import { useToastStore } from '../../common/toastStore'
import { askNumber, pick } from './prompts'

const toast = (msg: string, tone: 'info' | 'warn' | 'error' = 'info'): void =>
  useToastStore.getState().push(msg, tone)

/** Field names an address block looks for, in the order it prints them. */
const ADDRESS_FIELDS = ['Name', 'Company', 'Address1', 'Address2', 'City', 'State', 'Postcode', 'Country']

function needRecipients(): boolean {
  if (useMailingsStore.getState().recipients.length > 0) return true
  toast('Select recipients first — mail merge needs a list to work from.', 'warn')
  return false
}

/** Best-effort match of a wanted field against the actual CSV column names. */
function resolveField(wanted: string): string | null {
  const { fields } = useMailingsStore.getState()
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return fields.find((f) => norm(f) === norm(wanted)) ?? null
}

function loadRecipientsFile(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.csv,text/csv,text/plain'
  input.onchange = (): void => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (): void => {
      const { fields, rows } = parseCsv(String(reader.result ?? ''))
      if (fields.length === 0 || rows.length === 0) {
        toast('That file has no readable rows. The first line must be the column headings.', 'error')
        return
      }
      useMailingsStore.getState().setRecipients(fields, rows)
      toast(`${rows.length} recipients loaded — fields: ${fields.join(', ')}`)
    }
    reader.onerror = (): void => toast('Could not read that file.', 'error')
    reader.readAsText(file)
  }
  input.click()
}

export async function handleMailingsCommand(editor: Editor, command: string): Promise<boolean> {
  const store = useMailingsStore.getState()
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  switch (command) {
    case 'mailings.selectRecipients':
      loadRecipientsFile()
      return true

    case 'mailings.startMerge': {
      const kind = await pick('Merge to', ['Letters', 'Envelopes', 'Labels', 'Directory'] as const, store.kind)
      if (!kind) return true
      store.setKind(kind as MergeKind)
      if (store.recipients.length === 0) {
        toast(`${kind} merge started — now choose Select recipients.`)
        loadRecipientsFile()
        return true
      }
      toast(`${kind} merge started with ${store.activeRecipients().length} recipients.`)
      return true
    }

    case 'mailings.editList': {
      if (!needRecipients()) return true
      const { recipients, excluded, fields } = useMailingsStore.getState()
      const labels = recipients.map((r, i) => {
        const first = r[fields[0]] ?? `Row ${i + 1}`
        return `${excluded.has(i) ? '☐' : '☑'} ${first}`
      })
      const choice = await pick('Include or exclude a recipient', [...labels, 'Done'])
      if (!choice || choice === 'Done') return true
      useMailingsStore.getState().toggleExcluded(labels.indexOf(choice))
      const active = useMailingsStore.getState().activeRecipients().length
      toast(`${active} of ${recipients.length} recipients included.`)
      return true
    }

    case 'mailings.mergeField': {
      if (!needRecipients()) return true
      const field = await pick('Insert merge field', useMailingsStore.getState().fields)
      if (!field) return true
      chain().insertContent(`«${field}»`).run()
      return true
    }

    case 'mailings.addressBlock': {
      if (!needRecipients()) return true
      const present = ADDRESS_FIELDS.map(resolveField).filter((f): f is string => f !== null)
      if (present.length === 0) {
        toast(
          `No address columns found. Expected one of: ${ADDRESS_FIELDS.join(', ')}. Use Insert merge field instead.`,
          'warn'
        )
        return true
      }
      chain()
        .insertContent(
          present.map((f) => ({ type: 'paragraph', content: [{ type: 'text', text: `«${f}»` }] }))
        )
        .run()
      return true
    }

    case 'mailings.greetingLine': {
      if (!needRecipients()) return true
      const nameField = resolveField('Name') ?? resolveField('FirstName') ?? useMailingsStore.getState().fields[0]
      const salutation = await pick('Greeting', ['Dear', 'Hello', 'To', 'Attn:'] as const)
      if (!salutation) return true
      chain()
        .insertContent([
          { type: 'paragraph', content: [{ type: 'text', text: `${salutation} «${nameField}»,` }] }
        ])
        .run()
      return true
    }

    case 'mailings.preview': {
      if (!needRecipients()) return true
      const s = useMailingsStore.getState()
      const active = s.activeRecipients()
      if (active.length === 0) {
        toast('Every recipient is excluded — nothing to preview.', 'warn')
        return true
      }

      if (s.template === null) {
        // Stash the placeholder version so preview is reversible.
        s.beginPreview(editor.getHTML())
        editor.commands.setContent(applyMerge(editor.getHTML(), active[0]))
        toast(`Previewing 1 of ${active.length}. Press Preview results again to step forward.`)
        return true
      }

      const next = s.previewIndex + 1
      if (next >= active.length) {
        editor.commands.setContent(s.template)
        s.endPreview()
        toast('Back to the merge template.')
        return true
      }
      s.setPreviewIndex(next)
      editor.commands.setContent(applyMerge(s.template, active[next]))
      toast(`Previewing ${next + 1} of ${active.length}.`)
      return true
    }

    case 'mailings.finish': {
      if (!needRecipients()) return true
      const s = useMailingsStore.getState()
      const template = s.template ?? editor.getHTML()
      const active = s.activeRecipients()
      if (active.length === 0) {
        toast('Every recipient is excluded — nothing to merge.', 'warn')
        return true
      }
      if (!/«[^»]+»/.test(template)) {
        toast('No merge fields in the document. Insert at least one before finishing.', 'warn')
        return true
      }
      if (
        !window.confirm(
          `Merge ${active.length} recipients into this document?\n\nEach record is written one after another, separated by page breaks. The template is replaced.`
        )
      ) {
        return true
      }
      const merged = active.map((r) => applyMerge(template, r)).join('<div data-page-break="true"></div>')
      editor.commands.setContent(merged)
      s.endPreview()
      useDocumentStore.getState().markDirty()
      toast(`Merged ${active.length} records.`)
      return true
    }

    case 'mailings.envelopes': {
      const doc = useDocumentStore.getState()
      if (doc.pageSetup.orientation !== 'landscape') doc.cycleOrientation()
      useDocumentStore.setState((state) => ({
        pageSetup: {
          ...state.pageSetup,
          marginTopMm: 12.7,
          marginBottomMm: 12.7,
          marginLeftMm: 12.7,
          marginRightMm: 12.7
        },
        dirty: true
      }))
      const hasList = useMailingsStore.getState().recipients.length > 0
      chain()
        .insertContent([
          { type: 'paragraph', content: [{ type: 'text', text: 'Aiper' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '' }] },
          {
            type: 'paragraph',
            attrs: { textAlign: 'center' },
            content: [{ type: 'text', text: hasList ? '«Name»' : 'Recipient name' }]
          },
          {
            type: 'paragraph',
            attrs: { textAlign: 'center' },
            content: [{ type: 'text', text: hasList ? '«Address1»' : 'Address' }]
          }
        ])
        .run()
      toast('Envelope layout applied — landscape page with narrow margins.')
      return true
    }

    case 'mailings.labels': {
      const cols = await askNumber('Labels across the page', 3, 1, 6)
      if (cols === null) return true
      const rows = await askNumber('Labels down the page', 8, 1, 20)
      if (rows === null) return true
      const hasList = useMailingsStore.getState().recipients.length > 0
      chain().insertTable({ rows, cols, withHeaderRow: false }).run()
      if (hasList) {
        toast(`${cols}×${rows} label grid inserted. Add «field» placeholders, then Finish & merge.`)
      } else {
        toast(`${cols}×${rows} label grid inserted.`)
      }
      return true
    }

    default:
      return false
  }
}
