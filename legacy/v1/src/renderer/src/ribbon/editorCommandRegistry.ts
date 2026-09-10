/**
 * Ribbon buttons need to call into whichever Tiptap editor instance is currently
 * mounted (the main document editor, or a header/footer mini-editor), but the ribbon
 * itself is rendered outside the editor tree. The mounted editor registers its command
 * handler here on focus; ribbonActions looks it up by id instead of importing the editor
 * directly, keeping the ribbon config decoupled from any one editor instance.
 */
export type EditorCommandHandler = (command: string, payload?: unknown) => void | Promise<void>

const handlers = new Map<string, EditorCommandHandler>()
let activeId = 'main'

export function registerEditorCommandHandler(id: string, handler: EditorCommandHandler): () => void {
  handlers.set(id, handler)
  return () => {
    handlers.delete(id)
  }
}

export function setActiveEditor(id: string): void {
  activeId = id
}

/**
 * Returns false when no editor is mounted, so the caller can explain why nothing happened.
 *
 * `settled` resolves once the command has actually finished. Commands can now open a dialog
 * and therefore complete asynchronously; without this, "run it and see what it did" is a race.
 */
export function runEditorCommand(command: string, payload?: unknown): boolean {
  const handler = handlers.get(activeId) ?? handlers.get('main')
  if (!handler) {
    console.info(`[editor] no active editor to run "${command}"`)
    lastRun = Promise.resolve()
    return false
  }
  lastRun = Promise.resolve(handler(command, payload)).then(() => undefined)
  return true
}

let lastRun: Promise<void> = Promise.resolve()

/** Awaits the most recently dispatched editor command. Used by the ribbon coverage test. */
export function settled(): Promise<void> {
  return lastRun
}
