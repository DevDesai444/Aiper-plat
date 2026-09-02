import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import { useOutlineStore } from '../store/outlineStore'

export function useOutlineSync(editor: Editor | null): void {
  const setHeadings = useOutlineStore((s) => s.setHeadings)

  useEffect(() => {
    if (!editor) return

    const sync = (): void => {
      const headings: Array<{ id: string; level: number; text: string; pos: number }> = []
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          headings.push({ id: `h-${pos}`, level: Number(node.attrs.level) || 1, text: node.textContent, pos })
        }
      })
      setHeadings(headings)
    }

    sync()
    editor.on('update', sync)
    return () => {
      editor.off('update', sync)
    }
  }, [editor, setHeadings])
}
