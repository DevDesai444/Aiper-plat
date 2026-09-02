import { ipcMain, BrowserWindow } from 'electron'
import { aiProvider } from '../services/ai/provider'

export function registerAiHandlers(): void {
  ipcMain.handle('ai:sendMessage', async (event, threadId: string, text: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return await aiProvider.sendMessage(threadId, text, (chunk) => {
      win?.webContents.send('ai:messageChunk', threadId, chunk)
    })
  })
}
