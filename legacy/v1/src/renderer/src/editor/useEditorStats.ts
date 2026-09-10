import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorStatsStore } from '../store/editorStatsStore'

/** Page count here is an estimate (content height / a single A4 page's content height),
 *  not true pagination — see the plan's pagination notes for why real page-splitting only
 *  happens at print/export time via printToPDF. */
const PAGE_CONTENT_HEIGHT_PX = 1000

export function useEditorStats(editor: Editor | null): void {
  const setStats = useEditorStatsStore((s) => s.setStats)

  useEffect(() => {
    if (!editor) return

    const sync = (): void => {
      const words = editor.storage.characterCount?.words?.() ?? 0
      const chars = editor.storage.characterCount?.characters?.() ?? 0
      const pageBreaks = editor.state.doc.content.content.filter((n) => n.type.name === 'pageBreak').length
      const dom = editor.view.dom as HTMLElement
      const estimatedByHeight = Math.max(1, Math.ceil(dom.scrollHeight / PAGE_CONTENT_HEIGHT_PX))
      setStats({ wordCount: words, charCount: chars, totalPages: Math.max(pageBreaks + 1, estimatedByHeight), page: 1 })
    }

    sync()
    editor.on('update', sync)
    return () => {
      editor.off('update', sync)
    }
  }, [editor, setStats])
}
