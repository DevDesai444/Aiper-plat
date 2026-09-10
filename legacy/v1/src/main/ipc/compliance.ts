import { ipcMain, BrowserWindow, app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { complianceProvider } from '../services/compliance/provider'
import {
  DEFAULT_ENGINE_URL,
  readEngineSettings,
  writeEngineSettings
} from '../services/compliance/engineConfig'
import { exportDocx } from '../services/docx/export'
import type { AiperDocumentModel } from '../services/docx/model'

/**
 * What to analyse. A saved, unmodified file can be sent as-is; anything else has to be the
 * editor's current state, or the findings describe a version of the document nobody is
 * looking at. That is worse than no analysis: a reviewer would be clearing findings against
 * text they have already changed.
 */
export type ComplianceDocumentSource =
  | { kind: 'file'; path: string }
  | { kind: 'model'; fileName: string; model: AiperDocumentModel }
  /** Raw bytes — a file that lives in the project rather than on disk or in the editor. This
   *  is how a PDF gets checked at all: it can never be opened in the editor, but the engine
   *  reads PDFs perfectly well, including scanned ones through OCR. */
  | { kind: 'bytes'; fileName: string; base64: string }

/** Give the engine a real file to read, whatever form the document arrived in. */
async function materialise(source: ComplianceDocumentSource): Promise<{ path: string; temporary: boolean }> {
  if (source.kind === 'file') return { path: source.path, temporary: false }

  const safeName = source.fileName.replace(/[^\w.-]+/g, '_') || 'document.docx'
  const path = join(app.getPath('temp'), `aiper-compliance-${Date.now()}-${safeName}`)
  const buffer =
    source.kind === 'bytes' ? Buffer.from(source.base64, 'base64') : await exportDocx(source.model)
  await fs.writeFile(path, buffer)
  return { path, temporary: true }
}

export function registerComplianceHandlers(): void {
  ipcMain.handle(
    'compliance:checkDocument',
    async (event, docId: string, source: ComplianceDocumentSource, model?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const { path, temporary } = await materialise(source)
      try {
        return await complianceProvider.checkDocument(docId, path, {
          model,
          onProgress: (update) => win?.webContents.send('compliance:documentProgress', docId, update)
        })
      } finally {
        if (temporary) {
          // The export exists only for this request. Leaving it behind would scatter copies
          // of regulatory drafts through the OS temp directory.
          await fs.unlink(path).catch(() => undefined)
        }
      }
    }
  )

  ipcMain.handle('compliance:engineStatus', async () => complianceProvider.status())

  ipcMain.handle('compliance:listModels', async () => complianceProvider.listModels())

  ipcMain.handle('compliance:getEngineSettings', () => ({
    ...readEngineSettings(),
    defaultUrl: DEFAULT_ENGINE_URL,
    // Set by the environment, so the UI must not offer to edit it.
    urlLocked: Boolean(process.env.AIPER_COMPLIANCE_URL)
  }))

  ipcMain.handle('compliance:setEngineSettings', (_event, patch: { baseUrl?: string; model?: string }) =>
    writeEngineSettings(patch)
  )

  ipcMain.handle('compliance:checkFolder', async (event, folderId: string, folderPath: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return complianceProvider.checkFolder(folderId, folderPath, (update) => {
      win?.webContents.send('compliance:folderProgress', folderId, update)
    })
  })
}
