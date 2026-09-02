import { ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import type { PageSetup } from '../services/docx/model'

export function registerPrintHandlers(): void {
  ipcMain.handle(
    'print:exportPdf',
    async (event, outPath: string, pageSetup: PageSetup, headerHtml: string, footerHtml: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      const data = await win.webContents.printToPDF({
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: headerHtml,
        footerTemplate: footerHtml,
        margins: {
          top: pageSetup.marginTopMm / 25.4,
          bottom: pageSetup.marginBottomMm / 25.4,
          left: pageSetup.marginLeftMm / 25.4,
          right: pageSetup.marginRightMm / 25.4
        },
        pageSize: pageSetup.size === 'Letter' ? 'Letter' : 'A4',
        landscape: pageSetup.orientation === 'landscape'
      })
      await fs.writeFile(outPath, data)
      return true
    }
  )
}
