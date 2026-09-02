import type { Editor } from '@tiptap/core'
import { useDocumentStore } from '../../store/documentStore'
import { useOutlineStore } from '../../store/outlineStore'
import { useReferencesStore } from '../../store/referencesStore'
import { useToastStore } from '../../common/toastStore'
import {
  SHAPE_KINDS,
  ICON_KINDS,
  SMARTART_KINDS,
  chartSvg,
  iconSvg,
  rasterize,
  shapeSvg,
  smartArtSvg,
  wordArtSvg,
  type ChartKind
} from '../graphics'
import { askNumber, askText, parseDataPairs, pick } from './prompts'
import { insertPicture } from '../insertImage'

const toast = (msg: string): void => useToastStore.getState().push(msg)

/** Common scientific and regulatory characters, grouped the way the Symbol dialog lists them. */
const SYMBOLS = [
  '± — plus-minus',
  '× — multiplication',
  '÷ — division',
  '≤ — less or equal',
  '≥ — greater or equal',
  '≈ — approximately',
  '° — degree',
  'µ — micro',
  'α — alpha',
  'β — beta',
  'γ — gamma',
  'Δ — delta',
  'λ — lambda',
  '™ — trademark',
  '® — registered',
  '© — copyright',
  '§ — section',
  '† — dagger'
] as const

const EQUATIONS = [
  'x̄ = Σx / n',
  '%RSD = (SD / x̄) × 100',
  'Assay (%) = (A_sample / A_standard) × (C_standard / C_sample) × 100',
  'LOD = 3.3 × (σ / S)',
  'LOQ = 10 × (σ / S)',
  'Custom…'
] as const

const QUICK_PARTS: Record<string, string> = {
  'Confidentiality notice':
    'This document contains confidential information belonging to Aiper. It may not be reproduced or disclosed without written authorisation.',
  'Batch formula preamble':
    'The batch formula below is presented for the proposed commercial batch size. Quantities are expressed per batch and per unit dose.',
  'Specification justification':
    'The proposed acceptance criteria are justified by batch analysis data, stability results and the relevant ICH quality guidelines.',
  'Stability commitment':
    'Stability studies will continue through the proposed shelf life, and any out-of-specification result will be reported to the agency.'
}

/** Inserts a generated graphic, rasterised so it survives docx export. */
async function insertGraphic(editor: Editor, svg: string, alt: string): Promise<void> {
  insertPicture(editor, await rasterize(svg), alt)
}

export async function handleInsertCommand(editor: Editor, command: string): Promise<boolean> {
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()
  const accent = useDocumentStore.getState().accent

  switch (command) {
    case 'insert.coverPage': {
      const title = await askText('Document title', useDocumentStore.getState().fileName?.replace(/\.docx$/, '') ?? '')
      if (title === null) return true
      const subtitle = await askText('Subtitle or document code', '') ?? ''
      chain()
        .insertContentAt(0, [
          { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [{ type: 'text', text: title }] },
          ...(subtitle
            ? [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: subtitle }] }]
            : []),
          {
            type: 'paragraph',
            attrs: { textAlign: 'center' },
            content: [{ type: 'text', text: new Date().toLocaleDateString() }]
          },
          { type: 'pageBreak' }
        ])
        .run()
      return true
    }

    case 'insert.toc': {
      const headings = useOutlineStore.getState().headings
      if (headings.length === 0) {
        window.alert('Add some headings first — the table of contents lists them.')
        return true
      }
      chain()
        .insertContent([
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Table of contents' }] },
          ...headings.map((h) => ({
            type: 'paragraph',
            attrs: { indent: Math.max(h.level - 1, 0) },
            content: [{ type: 'text', text: h.text || 'Untitled heading' }]
          }))
        ])
        .run()
      return true
    }

    case 'insert.symbol': {
      const choice = await pick('Insert symbol', SYMBOLS)
      if (!choice) return true
      chain().insertContent(choice.charAt(0)).run()
      return true
    }

    case 'insert.equation': {
      const choice = await pick('Insert equation', EQUATIONS)
      if (!choice) return true
      const text = choice === 'Custom…' ? await askText('Equation text') : choice
      if (!text) return true
      chain()
        .insertContent([
          { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text }] }
        ])
        .run()
      return true
    }

    case 'insert.dateTime': {
      const now = new Date()
      const formats = [
        now.toLocaleDateString(),
        now.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
        now.toISOString().slice(0, 10),
        now.toLocaleString()
      ] as const
      const choice = await pick('Insert date and time', formats)
      if (!choice) return true
      chain().insertContent(choice).run()
      return true
    }

    case 'insert.textBox': {
      const text = await askText('Text box contents')
      if (!text) return true
      chain()
        .insertContent([{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }])
        .run()
      return true
    }

    case 'insert.dropCap': {
      const { from, to, empty } = editor.state.selection
      const paraStart = editor.state.selection.$from.start()
      const target = empty ? { from: paraStart, to: paraStart + 1 } : { from, to: Math.min(to, from + 1) }
      if (editor.state.doc.textBetween(target.from, target.to).trim() === '') {
        toast('Put the cursor in a paragraph that starts with a letter.')
        return true
      }
      chain().setTextSelection(target).setFontSize(32).toggleBold().setTextSelection(target.to).run()
      return true
    }

    case 'insert.wordArt': {
      const text = await askText('WordArt text')
      if (!text) return true
      void insertGraphic(editor, wordArtSvg(text, accent), text)
      return true
    }

    case 'insert.quickParts': {
      const names = Object.keys(QUICK_PARTS) as Array<keyof typeof QUICK_PARTS>
      const choice = await pick('Insert quick part', names)
      if (!choice) return true
      chain().insertContent([{ type: 'paragraph', content: [{ type: 'text', text: QUICK_PARTS[choice] }] }]).run()
      return true
    }

    case 'insert.signature': {
      const who = await askText('Name on the signature line', '') ?? ''
      const role = await askText('Role or title', '') ?? ''
      chain()
        .insertContent([
          { type: 'paragraph', content: [{ type: 'text', text: '________________________________' }] },
          {
            type: 'paragraph',
            attrs: { styleName: 'reference' },
            content: [{ type: 'text', text: `${who}${role ? `, ${role}` : ''}` }]
          },
          { type: 'paragraph', attrs: { styleName: 'reference' }, content: [{ type: 'text', text: 'Date: ____________' }] }
        ])
        .run()
      return true
    }

    case 'insert.object': {
      const input = document.createElement('input')
      input.type = 'file'
      input.onchange = (): void => {
        const file = input.files?.[0]
        if (!file) return
        editor
          .chain()
          .focus()
          .insertContent([
            {
              type: 'paragraph',
              attrs: { styleName: 'reference' },
              content: [{ type: 'text', text: `[Embedded object: ${file.name} — ${(file.size / 1024).toFixed(0)} KB]` }]
            }
          ])
          .run()
        toast(`Linked "${file.name}". Aiper records the reference; the file itself is not embedded.`)
      }
      input.click()
      return true
    }

    case 'insert.bookmark': {
      const name = await askText('Bookmark name')
      if (!name) return true
      useReferencesStore.getState().addBookmark(name, editor.state.selection.from)
      toast(`Bookmark "${name}" set.`)
      return true
    }

    case 'insert.crossReference': {
      const { bookmarks } = useReferencesStore.getState()
      const headings = useOutlineStore.getState().headings
      const targets = [
        ...headings.map((h) => `Heading: ${h.text || 'Untitled heading'}`),
        ...bookmarks.map((b) => `Bookmark: ${b.name}`)
      ]
      if (targets.length === 0) {
        toast('Add a heading or a bookmark first — a cross-reference needs a target.')
        return true
      }
      const choice = await pick('Cross-reference to', targets)
      if (!choice) return true
      chain().insertContent(choice.replace(/^(Heading|Bookmark): /, '')).run()
      return true
    }

    case 'insert.shapes': {
      const kind = await pick('Insert shape', SHAPE_KINDS)
      if (!kind) return true
      void insertGraphic(editor, shapeSvg(kind, accent), `${kind} shape`)
      return true
    }

    case 'insert.icons': {
      const kind = await pick('Insert icon', ICON_KINDS)
      if (!kind) return true
      void insertGraphic(editor, iconSvg(kind, accent), `${kind} icon`)
      return true
    }

    case 'insert.chart': {
      const kind = await pick('Chart type', ['column', 'bar', 'line', 'pie'] as const)
      if (!kind) return true
      const title = await askText('Chart title', '') ?? ''
      const raw = await askText(
        'Data — one "label = value" per line',
        'Batch 1 = 98.4\nBatch 2 = 99.1\nBatch 3 = 97.8'
      )
      if (raw === null) return true
      const points = parseDataPairs(raw)
      if (points.length === 0) {
        toast('No readable data points — use "label = value" on each line.')
        return true
      }
      void insertGraphic(editor, chartSvg(kind as ChartKind, points, accent, title), title || `${kind} chart`)
      return true
    }

    case 'insert.smartArt': {
      const kind = await pick('Diagram type', SMARTART_KINDS)
      if (!kind) return true
      const raw = await askText('Steps — one per line', 'Weigh\nBlend\nCompress\nCoat')
      if (raw === null) return true
      const steps = raw.split('\n').map((s) => s.trim()).filter(Boolean)
      if (steps.length === 0) {
        toast('Add at least one step.')
        return true
      }
      void insertGraphic(editor, smartArtSvg(kind, steps, accent), `${kind} diagram`)
      return true
    }

    case 'insert.screenshot': {
      if (!window.aiper?.media) {
        toast('Screen capture needs the desktop app.')
        return true
      }
      void window.aiper.media
        .listScreenSources()
        .then(async (sources) => {
          if (sources.length === 0) {
            toast('No screens or windows available to capture.')
            return
          }
          const choice = await pick(
            'Capture which screen or window?',
            sources.map((s) => s.name)
          )
          if (!choice) return
          const source = sources[sources.map((s) => s.name).indexOf(choice)]
          insertPicture(editor, source.thumbnail, `Screenshot — ${source.name}`)
        })
        .catch(() => toast('Screen capture was refused. Grant screen-recording permission to Aiper.'))
      return true
    }

    case 'insert.model3d':
      // A .glb/.fbx viewer plus an export path that Word can read is a feature in its own
      // right, and a regulatory document has no use for one. Say so instead of toasting a
      // generic "not implemented".
      toast('3D models aren’t supported — they have no representation in a .docx submission.')
      return true

    case 'insert.blankPage':
    case 'insert.pageBreak':
      chain().setPageBreak().run()
      return true

    case 'insert.table': {
      const rows = await askNumber('Rows', 3, 1, 50)
      if (rows === null) return true
      const cols = await askNumber('Columns', 3, 1, 20)
      if (cols === null) return true
      chain().insertTable({ rows, cols, withHeaderRow: true }).run()
      return true
    }

    default:
      return false
  }
}
