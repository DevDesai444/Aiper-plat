import { ipcMain, BrowserWindow, dialog, screen, desktopCapturer, shell } from 'electron'

/**
 * Mirror of the renderer's unsaved state, pushed on every change. The close handler runs in
 * the main process and cannot await the renderer, so the flag has to already be here.
 */
let hasUnsavedChanges = false

/**
 * Channel registration is process-global and must happen exactly once — `ipcMain.handle`
 * throws if the same channel is registered twice. Keep it out of per-window setup, which
 * runs again on macOS when the dock icon re-creates a closed window.
 */
export function registerWindowIpc(createWindow: () => BrowserWindow): void {
  ipcMain.handle('window:setDirty', (_event, dirty: boolean) => {
    hasUnsavedChanges = Boolean(dirty)
  })

  /**
   * Open a URL in the user's real browser. Restricted to https so a compromised renderer
   * cannot use this to launch a local file or a custom scheme handler.
   */
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('window:new', () => {
    createWindow()
    return true
  })

  /**
   * Tiles the open windows across the display holding the caller. `sideBySide` uses the two
   * most recent windows; `tile` lays out every window in a grid.
   */
  ipcMain.handle('window:arrange', (event, mode: 'sideBySide' | 'tile') => {
    const caller = BrowserWindow.fromWebContents(event.sender)
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (windows.length < 2) return false

    const area = screen.getDisplayNearestPoint(
      caller ? { x: caller.getBounds().x, y: caller.getBounds().y } : screen.getPrimaryDisplay().bounds
    ).workArea

    const targets = mode === 'sideBySide' ? windows.slice(-2) : windows
    const cols = mode === 'sideBySide' ? 2 : Math.ceil(Math.sqrt(targets.length))
    const rows = Math.ceil(targets.length / cols)
    const w = Math.floor(area.width / cols)
    const h = Math.floor(area.height / rows)

    targets.forEach((win, i) => {
      if (win.isMaximized()) win.unmaximize()
      win.setBounds({
        x: area.x + (i % cols) * w,
        y: area.y + Math.floor(i / cols) * h,
        width: w,
        height: h
      })
    })
    return true
  })

  /**
   * Screen capture for Insert → Screenshot. Sources are enumerated in the main process and
   * only the chosen thumbnail crosses to the renderer as a PNG data URL — the renderer never
   * gets a capture handle of its own.
   */
  ipcMain.handle('media:listScreenSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1920, height: 1200 }
    })
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
  })

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:maximizeToggle', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
}

/** Returns true when the window may close. */
function confirmClose(win: BrowserWindow): boolean {
  if (!hasUnsavedChanges) return true
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Cancel', 'Discard changes'],
    defaultId: 0,
    cancelId: 0,
    title: 'Unsaved changes',
    message: 'This document has unsaved changes.',
    detail: 'Closing now will discard them.'
  })
  return choice === 1
}

/** Per-window listeners. Safe to call for every window created. */
export function registerWindowHandlers(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (!confirmClose(win)) {
      event.preventDefault()
      return
    }
    // Prevent a second prompt if the renderer never clears the flag before teardown.
    hasUnsavedChanges = false
  })

  win.on('maximize', () => win.webContents.send('window:maximizeChanged', true))
  win.on('unmaximize', () => win.webContents.send('window:maximizeChanged', false))
}
