import { useCallback } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { useDocumentStore } from '../store/documentStore'

interface DocxReadResult {
  model: { title: string; content: JSONContent; pageSetup: import('../store/documentStore').PageSetup }
  warnings: string[]
}

export function useDocumentIO(editor: Editor | null): {
  save: () => Promise<void>
  openFromPath: (path: string) => Promise<void>
  exportPdf: () => Promise<void>
  printDocument: () => void
} {
  const filePath = useDocumentStore((s) => s.filePath)
  const fileName = useDocumentStore((s) => s.fileName)
  const pageSetup = useDocumentStore((s) => s.pageSetup)
  const headerText = useDocumentStore((s) => s.headerText)
  const footerText = useDocumentStore((s) => s.footerText)
  const openDocument = useDocumentStore((s) => s.openDocument)
  const markSaved = useDocumentStore((s) => s.markSaved)

  const save = useCallback(async () => {
    if (!editor || !window.aiper) return
    let targetPath = filePath
    if (!targetPath) {
      targetPath = await window.aiper.fs.saveFileDialog(fileName ?? 'Untitled document.docx')
      if (!targetPath) return
    }
    const model = {
      title: fileName ?? 'Untitled document',
      content: editor.getJSON(),
      pageSetup,
      header: headerText ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: headerText }] }] } : null,
      footer: footerText ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: footerText }] }] } : null
    }
    try {
      await window.aiper.docx.write(targetPath, model as never)
    } catch (err) {
      // Never swallow this. A failed write previously left dirty=true and surfaced only as
      // an unhandled rejection, so the user believed the document was saved when it wasn't.
      console.error('[save] write failed', err)
      window.alert(
        `Could not save "${fileName ?? 'document'}".\n\n${err instanceof Error ? err.message : String(err)}\n\nYour changes are still open and unsaved.`
      )
      return
    }
    const name = targetPath.split(/[\\/]/).pop() ?? fileName ?? 'Untitled document.docx'
    openDocument(targetPath, name, pageSetup)
    markSaved()
  }, [editor, filePath, fileName, pageSetup, headerText, footerText, openDocument, markSaved])

  const openFromPath = useCallback(
    async (path: string) => {
      if (!editor || !window.aiper) return
      let result: DocxReadResult
      try {
        result = (await window.aiper.docx.read(path)) as DocxReadResult
      } catch (err) {
        console.error('[open] read failed', err)
        window.alert(`Could not open that document.\n\n${err instanceof Error ? err.message : String(err)}`)
        return
      }

      // Surface data loss BEFORE replacing the editor contents, and let the user back out.
      // These warnings cover pre-existing tracked changes and comments, which Aiper cannot
      // preserve on import — silently discarding a reviewer's revision history is not
      // acceptable on a regulatory document.
      if (result.warnings.length > 0) {
        const proceed = window.confirm(
          `${result.warnings.join('\n\n')}\n\nOpen anyway? Choose Cancel to leave the file untouched and review it in Word first.`
        )
        if (!proceed) return
      }

      editor.commands.setContent(result.model.content)
      const name = path.split(/[\\/]/).pop() ?? result.model.title
      openDocument(path, name, result.model.pageSetup)
    },
    [editor, openDocument]
  )

  const exportPdf = useCallback(async () => {
    if (!window.aiper) return
    const outPath = await window.aiper.fs.saveFileDialog((fileName ?? 'document').replace(/\.docx$/, '.pdf'))
    if (!outPath) return
    const headerHtml = headerText
      ? `<div style="font-size:9px;width:100%;text-align:center;color:#888;">${headerText}</div>`
      : '<span></span>'
    const footerHtml = `<div style="font-size:9px;width:100%;text-align:center;color:#888;">${
      footerText ? footerText.replace('{page}', '<span class="pageNumber"></span>') : '<span class="pageNumber"></span> / <span class="totalPages"></span>'
    }</div>`
    await window.aiper.print.exportPdf(outPath, pageSetup, headerHtml, footerHtml)
  }, [fileName, pageSetup, headerText, footerText])

  /**
   * Opens the system print dialog. Print used to be wired straight to exportPdf, so the
   * Print button silently produced a file instead of printing and the Export PDF button
   * did nothing at all. A print stylesheet (editor.css, `@media print`) hides the shell so
   * only the page itself reaches the printer.
   */
  const printDocument = useCallback(() => {
    window.print()
  }, [])

  return { save, openFromPath, exportPdf, printDocument }
}
