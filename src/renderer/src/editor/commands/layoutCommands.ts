import type { Editor } from '@tiptap/core'
import { useDocumentStore } from '../../store/documentStore'
import { useToastStore } from '../../common/toastStore'
import { askNumber, pick } from './prompts'
import type { ImageAlign, ImageWrap } from '../extensions/imageAttributes'

const toast = (msg: string): void => useToastStore.getState().push(msg)

/** True when the selection is an image node the Arrange commands can act on. */
function selectedImage(editor: Editor): boolean {
  return editor.isActive('image')
}

function requireImage(editor: Editor): boolean {
  if (selectedImage(editor)) return true
  toast('Select a picture first — Arrange acts on the selected image.')
  return false
}

export async function handleLayoutCommand(editor: Editor, command: string): Promise<boolean> {
  const doc = useDocumentStore.getState()
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  switch (command) {
    case 'layout.margins': {
      doc.cycleMargins()
      toast(`Margins: ${useDocumentStore.getState().pageSetup.marginTopMm.toFixed(1)} mm`)
      return true
    }
    case 'layout.orientation': {
      doc.cycleOrientation()
      toast(`Orientation: ${useDocumentStore.getState().pageSetup.orientation}`)
      return true
    }
    case 'layout.sizeA4': {
      const size = doc.pageSetup.size === 'A4' ? 'Letter' : 'A4'
      useDocumentStore.setState((s) => ({ pageSetup: { ...s.pageSetup, size }, dirty: true }))
      toast(`Page size: ${size}`)
      return true
    }
    case 'layout.columns': {
      const columns = doc.cycleColumns()
      toast(`${columns} column${columns === 1 ? '' : 's'}`)
      return true
    }
    case 'layout.breaks':
      chain().setPageBreak().run()
      return true
    case 'layout.lineNumbers': {
      const on = doc.toggleLineNumbers()
      toast(`Line numbers ${on ? 'on' : 'off'}`)
      return true
    }
    case 'layout.indentLeft':
    case 'layout.indentRight': {
      const side = command === 'layout.indentLeft' ? 'left' : 'right'
      const steps = await askNumber(`Indent ${side} — number of levels (0 clears)`, 1, 0, 8)
      if (steps === null) return true
      // The indent extension steps one level at a time, so apply or clear by repetition.
      const type = editor.state.selection.$from.parent.type.name
      if (type !== 'paragraph' && type !== 'heading') {
        toast('Put the cursor in a paragraph first.')
        return true
      }
      const c = chain()
      if (steps === 0) c.updateAttributes(type, { indent: 0 })
      else c.updateAttributes(type, { indent: steps })
      c.run()
      return true
    }
    case 'layout.spacingBefore': {
      const pt = await askNumber('Space before paragraph (pt)', doc.paragraphSpacingPt, 0, 72)
      if (pt === null) return true
      useDocumentStore.setState({ paragraphSpacingPt: pt, dirty: true })
      toast(`Paragraph spacing: ${pt} pt`)
      return true
    }

    case 'arrange.position': {
      if (!requireImage(editor)) return true
      const choice = await pick('Picture position', ['left', 'center', 'right'] as const)
      if (!choice) return true
      chain().updateAttributes('image', { align: choice as ImageAlign, wrap: 'inline' }).run()
      return true
    }
    case 'arrange.wrapText': {
      if (!requireImage(editor)) return true
      const choice = await pick('Text wrapping', ['inline', 'left', 'right'] as const)
      if (!choice) return true
      chain().updateAttributes('image', { wrap: choice as ImageWrap, align: null }).run()
      return true
    }
    case 'arrange.align': {
      if (!requireImage(editor)) return true
      const choice = await pick('Align picture', ['left', 'center', 'right'] as const)
      if (!choice) return true
      chain().updateAttributes('image', { align: choice as ImageAlign }).run()
      return true
    }
    case 'arrange.bringForward':
    case 'arrange.sendBackward': {
      if (!requireImage(editor)) return true
      const delta = command === 'arrange.bringForward' ? 1 : -1
      const current = Number(editor.getAttributes('image').zIndex) || 0
      const next = Math.max(-10, Math.min(10, current + delta))
      chain().updateAttributes('image', { zIndex: next }).run()
      toast(`Layer ${next}`)
      return true
    }
    case 'arrange.rotate': {
      if (!requireImage(editor)) return true
      const current = Number(editor.getAttributes('image').rotate) || 0
      const next = (current + 90) % 360
      chain().updateAttributes('image', { rotate: next }).run()
      toast(`Rotated to ${next}°`)
      return true
    }
    case 'arrange.group': {
      if (!requireImage(editor)) return true
      // Grouping needs a canvas of floating objects; Aiper places pictures in the text flow,
      // so there is nothing to group. Say so rather than pretending the click did something.
      toast('Pictures sit in the text flow, so there is nothing to group. Use Wrap text to place them.')
      return true
    }

    default:
      return false
  }
}
