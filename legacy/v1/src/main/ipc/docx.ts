import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { importDocx } from '../services/docx/import'
import { exportDocx } from '../services/docx/export'
import type { AiperDocumentModel } from '../services/docx/model'

export function registerDocxHandlers(): void {
  ipcMain.handle('docx:read', async (_event, path: string) => {
    const buffer = await fs.readFile(path)
    return importDocx(buffer)
  })

  ipcMain.handle('docx:write', async (_event, path: string, model: AiperDocumentModel) => {
    const buffer = await exportDocx(model)
    await fs.writeFile(path, buffer)
    return true
  })

  ipcMain.handle('docx:createBlank', async (_event, path: string, model: AiperDocumentModel) => {
    const buffer = await exportDocx(model)
    await fs.writeFile(path, buffer)
    return true
  })
}
