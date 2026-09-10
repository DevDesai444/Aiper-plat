import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { readProjectTree } from '../services/fs/tree'
import { parseGitHubRemote } from '../services/fs/gitRemote'

/**
 * Every path passed in from the renderer must resolve inside the last folder opened
 * via openFolderDialog; readDirRecursive re-derives and caches that root per window
 * so a compromised renderer can't walk the handler outside the chosen project.
 */
const openRoots = new WeakMap<BrowserWindow, string>()

/** A single file is read whole into memory and then base64'd for the GitHub blob API, so the
 *  cap is about this process's memory, not GitHub's 100 MB blob limit — the import pre-flight
 *  enforces that separately and with a better message. */
const MAX_READ_BYTES = 80 * 1024 * 1024

function rootFor(event: Electron.IpcMainInvokeEvent): string | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win ? (openRoots.get(win) ?? null) : null
}

/**
 * Resolve `candidate` and confirm it is inside the window's opened root.
 *
 * `startsWith` on the raw strings is not enough — "/projects/alpha-secrets" starts with
 * "/projects/alpha". Comparing the relative path is what actually answers "is this contained".
 */
function containedPath(event: Electron.IpcMainInvokeEvent, candidate: string): string {
  const root = rootFor(event)
  if (!root) throw new Error('No project folder is open.')
  const full = resolve(candidate)
  const rel = relative(resolve(root), full)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('That path is outside the open project folder.')
  }
  return full
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:openFolderDialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    if (win) openRoots.set(win, root)
    return root
  })

  ipcMain.handle('fs:readDirRecursive', async (event, rootPath: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) openRoots.set(win, rootPath)
    return readProjectTree(rootPath)
  })

  /** File bytes, base64'd for the GitHub blob API. Binary-safe: the import must not corrupt
   *  a PDF by round-tripping it through a string encoding. */
  ipcMain.handle('fs:readFileBase64', async (event, path: string) => {
    const full = containedPath(event, path)
    const stat = await fs.stat(full)
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`${path} is ${Math.round(stat.size / 1024 / 1024)} MB — too large to import.`)
    }
    const buffer = await fs.readFile(full)
    return buffer.toString('base64')
  })

  /** The GitHub origin of a local folder, or null when it is not a git repo / not on GitHub.
   *  This is what decides "connect to the existing project" versus "create a new one". */
  ipcMain.handle('fs:gitHubRemote', async (event, path: string) => {
    const full = containedPath(event, path)
    try {
      const config = await fs.readFile(join(full, '.git', 'config'), 'utf8')
      return parseGitHubRemote(config)
    } catch {
      return null // no .git, unreadable, or no origin — all mean "not linked"
    }
  })

  ipcMain.handle('fs:saveFileDialog', async (event, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: 'Word Document', extensions: ['docx'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('fs:openFileDialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Word Document', extensions: ['docx'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  /** Pick any file to upload into a project, and remember its directory as a read root so the
   *  subsequent readFileBase64 is allowed. Separate from openFileDialog, which is the
   *  open-in-editor path and is deliberately .docx-only. */
  ipcMain.handle('fs:pickFileForUpload', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, { properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (win) openRoots.set(win, resolve(picked, '..'))
    return picked
  })
}
