import type { Editor } from '@tiptap/core'

/**
 * Adds a picture at the cursor.
 *
 * Inserting an image leaves that image selected (a ProseMirror NodeSelection), and a second
 * insert at a node selection *replaces* the selected node. So inserting two pictures in a row
 * silently overwrote the first. Collapsing to the end of the selection first makes each
 * insert additive, which is what every one of these buttons is supposed to do.
 */
export function insertPicture(editor: Editor, src: string, alt: string): void {
  editor
    .chain()
    .focus()
    .setTextSelection(editor.state.selection.to)
    .insertContent({ type: 'image', attrs: { src, alt } })
    .run()
}

/** Uses a plain HTML file input rather than an Electron dialog IPC round-trip — file
 *  reading happens entirely in the renderer via FileReader, no main-process access needed,
 *  and it works identically whether or not the Electron preload bridge is present. */
export function insertImage(editor: Editor): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp'
  input.onchange = (): void => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (): void => {
      insertPicture(editor, reader.result as string, file.name)
    }
    reader.readAsDataURL(file)
  }
  input.click()
}
