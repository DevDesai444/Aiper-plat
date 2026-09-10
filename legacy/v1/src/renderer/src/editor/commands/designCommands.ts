import type { Editor } from '@tiptap/core'
import { useDocumentStore, THEMES } from '../../store/documentStore'
import { useToastStore } from '../../common/toastStore'
import { askText, pick } from './prompts'

const toast = (msg: string): void => useToastStore.getState().push(msg)

const BODY_FONTS = ['Times New Roman', 'Arial', 'Calibri', 'Georgia', 'Courier New'] as const
const PAGE_COLORS = ['None', 'Warm white', 'Cool grey', 'Pale blue', 'Pale green'] as const
const PAGE_COLOR_VALUES: Record<(typeof PAGE_COLORS)[number], string | null> = {
  None: null,
  'Warm white': '#fdfbf6',
  'Cool grey': '#f4f5f7',
  'Pale blue': '#f3f7fc',
  'Pale green': '#f4faf5'
}

export async function handleDesignCommand(editor: Editor, command: string): Promise<boolean> {
  const doc = useDocumentStore.getState()

  switch (command) {
    case 'design.theme.aiperCtd':
    case 'design.theme.ectdPlain': {
      const key = command === 'design.theme.aiperCtd' ? 'aiperCtd' : 'ectdPlain'
      const theme = doc.setTheme(key)
      // Apply the theme's body font to the whole document, not just new typing — a theme
      // that only affects future keystrokes is not a theme.
      editor.chain().focus().selectAll().setFontFamily(theme.bodyFont).run()
      editor.commands.setTextSelection(editor.state.selection.to)
      toast(`Theme: ${theme.name}`)
      return true
    }

    case 'design.colors': {
      const accent = doc.cycleAccent()
      toast(`Accent ${accent}`)
      return true
    }

    case 'design.fonts': {
      const choice = await pick('Document font', BODY_FONTS, doc.theme.bodyFont as (typeof BODY_FONTS)[number])
      if (!choice) return true
      useDocumentStore.setState((s) => ({ theme: { ...s.theme, bodyFont: choice }, dirty: true }))
      editor.chain().focus().selectAll().setFontFamily(choice).run()
      editor.commands.setTextSelection(editor.state.selection.to)
      toast(`Font: ${choice}`)
      return true
    }

    case 'design.spacing': {
      const pt = doc.cycleParagraphSpacing()
      toast(`Paragraph spacing: ${pt} pt`)
      return true
    }

    case 'design.effects': {
      const on = doc.toggleShadowEffects()
      toast(`Page shadow ${on ? 'on' : 'off'}`)
      return true
    }

    case 'design.watermark': {
      const text = await askText('Watermark text (blank removes it)', doc.watermark || 'DRAFT')
      if (text === null) return true
      doc.setWatermark(text.trim())
      toast(text.trim() ? `Watermark: ${text.trim()}` : 'Watermark removed')
      return true
    }

    case 'design.pageColor': {
      const current = (Object.keys(PAGE_COLOR_VALUES) as Array<(typeof PAGE_COLORS)[number]>).find(
        (k) => PAGE_COLOR_VALUES[k] === doc.pageColor
      )
      const choice = await pick('Page colour', PAGE_COLORS, current)
      if (!choice) return true
      doc.setPageColor(PAGE_COLOR_VALUES[choice])
      toast(`Page colour: ${choice}`)
      return true
    }

    case 'design.pageBorders': {
      const on = doc.togglePageBorders()
      toast(`Page border ${on ? 'on' : 'off'}`)
      return true
    }

    case 'styles.gallery': {
      const styles = ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'CTD section', 'Reference', 'Table caption'] as const
      const choice = await pick('Apply style', styles)
      if (!choice) return true
      const chain = editor.chain().focus()
      switch (choice) {
        case 'Heading 1':
          chain.setHeading({ level: 1 }).run()
          break
        case 'Heading 2':
          chain.setHeading({ level: 2 }).run()
          break
        case 'Heading 3':
          chain.setHeading({ level: 3 }).run()
          break
        case 'CTD section':
          chain.setParagraph().updateAttributes('paragraph', { styleName: 'ctdSection' }).run()
          break
        case 'Reference':
          chain.setParagraph().updateAttributes('paragraph', { styleName: 'reference' }).run()
          break
        case 'Table caption':
          chain.setParagraph().updateAttributes('paragraph', { styleName: 'tableCaption' }).run()
          break
        default:
          chain.setParagraph().updateAttributes('paragraph', { styleName: null }).run()
      }
      return true
    }

    default:
      return false
  }
}

export { THEMES }
