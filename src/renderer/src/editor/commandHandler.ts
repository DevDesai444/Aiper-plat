import type { Editor } from '@tiptap/core'
import type { ParagraphStyleName } from './extensions/paragraphStyle'
import { useDocumentStore } from '../store/documentStore'
import { notImplemented, useToastStore } from '../common/toastStore'
import { askText } from '../common/promptStore'
import { handleInsertCommand } from './commands/insertCommands'
import { handleLayoutCommand } from './commands/layoutCommands'
import { handleDesignCommand } from './commands/designCommands'
import { handleReferenceCommand } from './commands/referenceCommands'
import { handleReviewCommand } from './commands/reviewCommands'
import { handleMailingsCommand } from './commands/mailingsCommands'

const LINE_SPACINGS = [1, 1.15, 1.5, 2]

function cycleLineSpacing(editor: Editor): void {
  const type = editor.state.selection.$from.parent.type.name
  if (type !== 'paragraph' && type !== 'heading') return
  const current = Number(editor.getAttributes(type).lineSpacing) || 1
  const idx = LINE_SPACINGS.indexOf(current)
  const next = LINE_SPACINGS[(idx + 1) % LINE_SPACINGS.length]
  editor.chain().focus().updateAttributes(type, { lineSpacing: next }).run()
}

function setParagraphStyle(editor: Editor, styleName: ParagraphStyleName): void {
  const chain = editor.chain().focus()
  if (styleName === null) {
    chain.setParagraph().updateAttributes('paragraph', { styleName: null }).run()
    return
  }
  chain.setParagraph().updateAttributes('paragraph', { styleName }).run()
}

/** Commands owned by EditorCanvas (save, print, find, image) — resolved before this runs. */
const HANDLED_UPSTREAM = new Set([
  'save',
  'print',
  'compliance.checkDocument',
  'compliance.checkFolder',
  'insert.image',
  'edit.find',
  'edit.replace'
])

/**
 * Ribbon groups that own a slice of the command space. Each returns true when it recognised
 * the command. Splitting them out keeps this file a dispatcher rather than a 900-line switch,
 * and — more importantly — means a new command only has to be added in one place instead of
 * being implemented here and separately allow-listed in ribbonActions.
 */
const GROUP_HANDLERS = [
  handleInsertCommand,
  handleLayoutCommand,
  handleDesignCommand,
  handleReferenceCommand,
  handleReviewCommand,
  handleMailingsCommand
]

export async function handleEditorCommand(editor: Editor, command: string, payload?: unknown): Promise<void> {
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  switch (command) {
    case 'mark.bold':
      chain().toggleBold().run()
      return
    case 'mark.italic':
      chain().toggleItalic().run()
      return
    case 'mark.underline':
      chain().toggleUnderline().run()
      return
    case 'mark.strike':
      chain().toggleStrike().run()
      return
    case 'mark.subscript':
      chain().toggleSubscript().run()
      return
    case 'mark.superscript':
      chain().toggleSuperscript().run()
      return
    case 'mark.clearFormatting':
      chain().unsetAllMarks().clearNodes().run()
      return

    case 'font.grow': {
      const current = Number(editor.getAttributes('textStyle').fontSize) || 11
      chain().setFontSize(Math.min(current + 1, 96)).run()
      return
    }
    case 'font.shrink': {
      const current = Number(editor.getAttributes('textStyle').fontSize) || 11
      chain().setFontSize(Math.max(current - 1, 6)).run()
      return
    }
    case 'font.setFamily':
      chain().setFontFamily(String(payload)).run()
      return
    case 'font.setSize':
      chain().setFontSize(Number(payload)).run()
      return
    case 'font.changeCase': {
      const { from, to, empty } = editor.state.selection
      if (empty) return
      const text = editor.state.doc.textBetween(from, to)
      const isUpper = text === text.toUpperCase()
      chain().insertContentAt({ from, to }, isUpper ? text.toLowerCase() : text.toUpperCase()).run()
      return
    }

    case 'align.left':
      chain().setTextAlign('left').run()
      return
    case 'align.center':
      chain().setTextAlign('center').run()
      return
    case 'align.right':
      chain().setTextAlign('right').run()
      return
    case 'align.justify':
      chain().setTextAlign('justify').run()
      return

    case 'list.bullet':
      chain().toggleBulletList().run()
      return
    case 'list.ordered':
      chain().toggleOrderedList().run()
      return

    case 'paragraph.indent':
      chain().indent().run()
      return
    case 'paragraph.outdent':
      chain().outdent().run()
      return
    case 'paragraph.lineSpacing':
      cycleLineSpacing(editor)
      return

    case 'style.heading1':
      chain().setHeading({ level: 1 }).run()
      return
    case 'style.heading2':
      chain().setHeading({ level: 2 }).run()
      return
    case 'style.normal':
      setParagraphStyle(editor, null)
      return
    case 'style.tableCaption':
      setParagraphStyle(editor, 'tableCaption')
      return
    case 'style.ctdSection':
      setParagraphStyle(editor, 'ctdSection')
      return
    case 'style.reference':
      setParagraphStyle(editor, 'reference')
      return

    case 'insert.link': {
      const url = await askText('Link URL', '', { hint: 'For example https://www.fda.gov' })
      if (url?.trim()) chain().setLink({ href: url.trim() }).run()
      return
    }
    case 'insert.comment':
      await handleReviewCommand(editor, 'comment.new')
      return
    case 'insert.header': {
      const text = await askText('Header text', useDocumentStore.getState().headerText)
      if (text !== null) useDocumentStore.getState().setHeaderText(text)
      return
    }
    case 'insert.footer':
    case 'insert.pageNumber': {
      const text = await askText('Footer text', useDocumentStore.getState().footerText, {
        hint: 'Use {page} where the page number should appear.'
      })
      if (text !== null) useDocumentStore.getState().setFooterText(text)
      return
    }

    case 'edit.cut':
    case 'edit.copy': {
      // execCommand was the only path here, and it throws where it is unavailable rather
      // than reporting failure. Go through the clipboard API and keep execCommand as the
      // fallback, so the ribbon buttons behave like Ctrl-X/Ctrl-C everywhere.
      const { from, to, empty } = editor.state.selection
      if (empty) {
        toast('Select something to ' + (command === 'edit.cut' ? 'cut' : 'copy') + ' first.')
        return
      }
      const text = editor.state.doc.textBetween(from, to, '\n', ' ')
      const remove = (): void => {
        if (command === 'edit.cut') chain().deleteSelection().run()
      }
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard
          .writeText(text)
          .then(remove)
          .catch(() => toast('The clipboard is not available.', 'warn'))
        return
      }
      try {
        document.execCommand(command === 'edit.cut' ? 'cut' : 'copy')
      } catch {
        toast('The clipboard is not available.', 'warn')
      }
      return
    }
    case 'edit.paste': {
      // Electron's renderer can read the system clipboard directly; execCommand('paste') is
      // blocked, which is why this button previously did nothing at all.
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) chain().insertContent(text).run()
        })
        .catch(() => notImplemented('Paste'))
      return
    }
    case 'edit.select':
      chain().selectAll().run()
      return

    case 'outline.goto': {
      const pos = Number(payload)
      if (!Number.isFinite(pos)) return
      editor.chain().focus().setTextSelection(Math.min(pos + 1, editor.state.doc.content.size)).scrollIntoView().run()
      return
    }
    case 'edit.formatPainter':
      copyOrApplyFormatting(editor)
      return

    default: {
      if (HANDLED_UPSTREAM.has(command)) return
      // Awaited in order: a group handler may open a dialog before it knows whether it
      // recognised the command, so "did anyone handle this?" is only answerable afterwards.
      for (const handler of GROUP_HANDLERS) {
        if (await handler(editor, command)) return
      }
      const leaf = command.includes('.') ? command.slice(command.indexOf('.') + 1) : command
      const label = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      notImplemented(label.charAt(0).toUpperCase() + label.slice(1))
    }
  }
}

/** Format painter: first click copies the marks at the cursor, second click applies them. */
let copiedMarks: Array<{ type: string; attrs: Record<string, unknown> }> | null = null

function copyOrApplyFormatting(editor: Editor): void {
  const { empty, from, to } = editor.state.selection
  if (!copiedMarks || empty) {
    const marks = editor.state.selection.$from.marks()
    copiedMarks = marks.map((m) => ({ type: m.type.name, attrs: { ...m.attrs } }))
    toast(
      `Formatting copied — select the text to paint${copiedMarks.length === 0 ? ' (no formatting at the cursor)' : ''}.`
    )
    return
  }
  const chain = editor.chain().focus().setTextSelection({ from, to }).unsetAllMarks()
  for (const mark of copiedMarks) chain.setMark(mark.type, mark.attrs)
  chain.run()
  copiedMarks = null
  toast('Formatting applied.')
}

function toast(message: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
  useToastStore.getState().push(message, tone)
}
