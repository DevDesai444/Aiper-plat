import type { Editor } from '@tiptap/core'
import {
  useReferencesStore,
  formatBibliography,
  formatCitation,
  type Caption
} from '../../store/referencesStore'
import { useOutlineStore } from '../../store/outlineStore'
import { useToastStore } from '../../common/toastStore'
import { askText, pick } from './prompts'

const toast = (msg: string): void => useToastStore.getState().push(msg)

/** Finds the next occurrence of `needle` after `from`, wrapping to the start of the document. */
function findNext(editor: Editor, needle: string, from: number): number | null {
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n')
  const after = text.indexOf(needle, from)
  const at = after === -1 ? text.indexOf(needle) : after
  return at === -1 ? null : at
}

export async function handleReferenceCommand(editor: Editor, command: string): Promise<boolean> {
  const refs = useReferencesStore.getState()
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  switch (command) {
    case 'toc.addText':
    case 'toc.update': {
      const headings = useOutlineStore.getState().headings
      if (headings.length === 0) {
        window.alert('Add some headings first — the table of contents lists them.')
        return true
      }
      chain()
        .insertContent(
          headings.map((h) => ({
            type: 'paragraph',
            attrs: { indent: Math.max(h.level - 1, 0) },
            content: [{ type: 'text', text: h.text || 'Untitled heading' }]
          }))
        )
        .run()
      return true
    }

    case 'footnote.insert': {
      const text = await askText('Footnote text')
      if (!text) return true
      const note = refs.addFootnote(text)
      chain().toggleSuperscript().insertContent(String(note.number)).toggleSuperscript().run()
      toast(`Footnote ${note.number} added — it appears under the page.`)
      return true
    }

    case 'footnote.next': {
      const { footnotes } = useReferencesStore.getState()
      if (footnotes.length === 0) {
        toast('No footnotes yet.')
        return true
      }
      const from = editor.state.selection.to
      for (const n of footnotes) {
        const at = findNext(editor, String(n.number), from)
        if (at !== null) {
          editor.commands.setTextSelection({ from: at, to: at + String(n.number).length })
          editor.commands.scrollIntoView()
          toast(`Footnote ${n.number}: ${n.text}`)
          return true
        }
      }
      toast('Could not locate the next footnote marker.')
      return true
    }

    case 'citation.insert': {
      const { sources, citationStyle } = useReferencesStore.getState()
      const options = [...sources.map((s) => `${s.author} (${s.year}) — ${s.title}`), 'New source…']
      const choice = await pick('Insert citation', options)
      if (!choice) return true

      let source = sources[options.indexOf(choice)]
      if (choice === 'New source…') {
        const author = await askText('Author or issuing body', 'ICH')
        if (!author) return true
        const title = await askText('Title', '') ?? ''
        const year = await askText('Year', String(new Date().getFullYear())) ?? ''
        const detail = await askText('Detail (journal, guideline number…)', '') ?? ''
        source = useReferencesStore.getState().addSource({ author, title, year, detail })
      }
      if (!source) return true
      const index = useReferencesStore.getState().sources.findIndex((s) => s.id === source.id) + 1
      chain().insertContent(formatCitation(source, citationStyle, index)).run()
      return true
    }

    case 'citation.manageSources': {
      const { sources } = useReferencesStore.getState()
      if (sources.length === 0) {
        toast('No sources yet — add one with Insert citation.')
        return true
      }
      const choice = await pick(
        'Sources — pick one to remove',
        [...sources.map((s) => `${s.author} (${s.year}) — ${s.title}`), 'Keep all']
      )
      if (!choice || choice === 'Keep all') return true
      const target = sources[sources.findIndex((s) => `${s.author} (${s.year}) — ${s.title}` === choice)]
      if (target) {
        useReferencesStore.getState().removeSource(target.id)
        toast('Source removed.')
      }
      return true
    }

    case 'citation.style': {
      const style = refs.cycleCitationStyle()
      toast(`Citation style: ${style}`)
      return true
    }

    case 'citation.bibliography': {
      const { sources, citationStyle } = useReferencesStore.getState()
      if (sources.length === 0) {
        toast('No sources to list — add citations first.')
        return true
      }
      chain()
        .insertContent([
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'References' }] },
          ...sources.map((s, i) => ({
            type: 'paragraph',
            attrs: { styleName: 'reference' },
            content: [{ type: 'text', text: formatBibliography(s, citationStyle, i + 1) }]
          }))
        ])
        .run()
      return true
    }

    case 'caption.insert': {
      const kind = await pick('Caption for', ['Figure', 'Table', 'Equation'] as const)
      if (!kind) return true
      const text = await askText(`${kind} caption text`)
      if (text === null) return true
      const caption = refs.addCaption(kind as Caption['kind'], text)
      chain()
        .insertContent([
          {
            type: 'paragraph',
            attrs: { styleName: 'tableCaption' },
            content: [{ type: 'text', text: `${caption.kind} ${caption.number}. ${caption.text}` }]
          }
        ])
        .run()
      return true
    }

    case 'caption.figureTable': {
      const { captions } = useReferencesStore.getState()
      if (captions.length === 0) {
        toast('No captions yet — insert a caption first.')
        return true
      }
      chain()
        .insertContent([
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Table of figures' }] },
          ...captions.map((c) => ({
            type: 'paragraph',
            attrs: { styleName: 'reference' },
            content: [{ type: 'text', text: `${c.kind} ${c.number}. ${c.text}` }]
          }))
        ])
        .run()
      return true
    }

    case 'index.markEntry': {
      const { from, to, empty } = editor.state.selection
      const selected = empty ? '' : editor.state.doc.textBetween(from, to)
      const term = await askText('Index entry', selected)
      if (!term) return true
      refs.addIndexEntry(term)
      toast(`Marked "${term}" for the index.`)
      return true
    }

    case 'index.insert':
    case 'index.update': {
      const { indexEntries } = useReferencesStore.getState()
      if (indexEntries.length === 0) {
        toast('No index entries yet — use Mark entry first.')
        return true
      }
      const sorted = [...indexEntries].sort((a, b) => a.term.localeCompare(b.term))
      chain()
        .insertContent([
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Index' }] },
          ...sorted.map((e) => ({
            type: 'paragraph',
            attrs: { styleName: 'reference' },
            content: [{ type: 'text', text: e.term }]
          }))
        ])
        .run()
      toast(`${sorted.length} entries listed.`)
      return true
    }

    default:
      return false
  }
}
