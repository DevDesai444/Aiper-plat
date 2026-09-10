import { app, shell, BrowserWindow, Menu, MenuItem } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerFsHandlers } from './ipc/fs'
import { registerDocxHandlers } from './ipc/docx'
import { registerPrintHandlers } from './ipc/print'
import { registerComplianceHandlers } from './ipc/compliance'
import { registerAiHandlers } from './ipc/ai'
import { registerWindowHandlers, registerWindowIpc } from './ipc/window'
import { applyCsp } from './ipc/settings'
import { registerGithubAuthIpc } from './ipc/github-auth'

export function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1113',
    // macOS keeps its native traffic lights (top-left, inset into our title bar);
    // Windows/Linux get a frameless window and the renderer's own controls top-right.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Renderer errors otherwise vanish into a DevTools window nobody has open, which is how a
  // blank screen ends up with no explanation anywhere.
  if (is.dev) {
    mainWindow.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
      console.log(`[renderer] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] failed to load ${url}: ${desc} (${code})`)
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.misspelledWord && params.dictionarySuggestions.length === 0) return
    const menu = new Menu()
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion)
        })
      )
    }
    if (params.misspelledWord) {
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({
          label: 'Add to dictionary',
          click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        })
      )
    }
    menu.popup()
  })

  registerWindowHandlers(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.aiper.aiper')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  applyCsp()
  registerGithubAuthIpc()
  registerWindowIpc(createMainWindow)
  registerFsHandlers()
  registerDocxHandlers()
  registerPrintHandlers()
  registerComplianceHandlers()
  registerAiHandlers()

  createMainWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
