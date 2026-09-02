/**
 * Drives every control in the ribbon through the real dispatcher and asserts it reaches a
 * handler.
 *
 * This guards a specific failure that shipped: ribbonActions forwarded only an allow-list of
 * command prefixes to the editor, so commands written outside those prefixes — Margins,
 * Orientation, Word count, New comment, the whole References tab — were fully implemented and
 * still told the user they were "not implemented yet". Nothing crashed, nothing failed to
 * compile, and the tests passed. Only clicking the button revealed it.
 *
 * A command counts as reachable when it neither falls through to the generic
 * "isn't implemented yet" toast nor throws. Commands that deliberately decline (macros,
 * dictation, translation, 3D models) are listed explicitly below, so adding one is a
 * conscious act rather than an oversight.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.HTMLElement = dom.window.HTMLElement
g.Node = dom.window.Node
g.getComputedStyle = dom.window.getComputedStyle
// Node 22 defines globalThis.navigator as a getter-only property, so it has to be redefined
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
g.localStorage = dom.window.localStorage
g.WebSocket = dom.window.WebSocket
g.fetch = async (): Promise<never> => {
  throw new Error('network disabled in tests')
}

// Every dialog answers "cancel"/"no" so no command can block or mutate beyond its first step.
// A command must still route correctly even when the user backs out of its prompt. Electron
// has no window.prompt, so prompts go through the in-app dialog; with no dialog mounted here,
// an unanswered prompt would hang forever and every prompting command would pass vacuously.
// Auto-cancelling reproduces the old `window.prompt = () => null` behaviour.
dom.window.confirm = (): boolean => false
dom.window.alert = (): void => undefined
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { readText: async (): Promise<string> => '', writeText: async (): Promise<void> => undefined },
  configurable: true
})
// jsdom has neither of these; Electron's Chromium has both. Stub them so the commands that
// depend on them exercise their real path instead of their absent-capability fallback.
dom.window.document.execCommand = (): boolean => true
;(dom.window as unknown as Record<string, unknown>).speechSynthesis = {
  speaking: false,
  speak: (): void => undefined,
  cancel: (): void => undefined
}
;(dom.window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
  constructor(readonly text: string) {}
}

// Stands in for the Electron preload bridge. Every call resolves rather than doing real work,
// which is enough to prove the command reaches it.
;(dom.window as unknown as Record<string, unknown>).aiper = {
  platform: 'darwin',
  window: {
    newWindow: async (): Promise<boolean> => true,
    arrange: async (): Promise<boolean> => true,
    setDirty: async (): Promise<void> => undefined
  },
  fs: {
    openFolderDialog: async (): Promise<string | null> => null,
    saveFileDialog: async (): Promise<string | null> => null,
    // Every picker returns null (cancelled), so a control is exercised as far as the dialog
    // and no further — this test must never create a repository or touch the network.
    openFileDialog: async (): Promise<string | null> => null,
    pickFileForUpload: async (): Promise<string | null> => null,
    readFileBase64: async (): Promise<string> => '',
    gitHubRemote: async (): Promise<null> => null
  },
  docx: { write: async (): Promise<boolean> => true },
  media: { listScreenSources: async (): Promise<unknown[]> => [] },
  compliance: {
    checkDocument: async (): Promise<null> => null,
    checkFolder: async (): Promise<null> => null
  }
}

const { RIBBON } = await import('../src/renderer/src/ribbon/ribbonConfig')
const { runRibbonAction } = await import('../src/renderer/src/ribbon/ribbonActions')
const { registerEditorCommandHandler, settled } = await import('../src/renderer/src/ribbon/editorCommandRegistry')
const { handleEditorCommand } = await import('../src/renderer/src/editor/commandHandler')
const { useToastStore } = await import('../src/renderer/src/common/toastStore')
const { usePromptStore } = await import('../src/renderer/src/common/promptStore')

usePromptStore.subscribe((state) => {
  if (state.request) usePromptStore.getState().answer(null)
})

/**
 * Stand-in for a mounted Tiptap editor. Command modules only ever build a fluent chain and
 * read a little state, so a recording proxy exercises the real dispatch path without booting
 * ProseMirror in jsdom.
 */
function makeEditorStub(): { editor: unknown; calls: string[] } {
  const calls: string[] = []
  const chainProxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'run') return () => true
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.map((a) => JSON.stringify(a) ?? '').join(',')})`)
          return chainProxy
        }
      }
    }
  )

  const doc = {
    content: { size: 10 },
    textBetween: () => 'sample text',
    descendants: () => undefined,
    nodeAt: () => null
  }
  const selection = {
    from: 1,
    to: 1,
    empty: true,
    $from: { parent: { type: { name: 'paragraph' } }, marks: () => [], start: () => 0 }
  }

  const editor = {
    chain: () => chainProxy,
    commands: new Proxy({}, { get: () => () => true }),
    state: { doc, selection },
    storage: { characterCount: { words: () => 42, characters: () => 220 } },
    getAttributes: () => ({}),
    getHTML: () => '<p>sample text</p>',
    isActive: () => false,
    setEditable: () => undefined,
    setOptions: () => undefined,
    on: () => undefined,
    off: () => undefined
  }
  return { editor, calls }
}

const { editor } = makeEditorStub()
registerEditorCommandHandler('main', (command, payload) => {
  // Mirrors EditorCanvas: a few commands are owned by the canvas, the rest go to the handler.
  if (['save', 'print', 'exportPdf', 'compliance.checkDocument', 'edit.find', 'edit.replace', 'insert.image'].includes(command)) {
    return
  }
  return handleEditorCommand(editor as never, command, payload)
})

/** Commands that intentionally refuse, with the reason surfaced to the user. */
const DELIBERATE_REFUSALS = new Set([
  'view.split',
  'view.macros',
  'voice.dictate',
  'insert.model3d',
  'review.thesaurus',
  'review.translate'
])

interface Control {
  act: string
  label: string
  tab: string
}

const controls: Control[] = []
for (const [tab, groups] of Object.entries(RIBBON)) {
  for (const group of groups) {
    for (const b of group.big ?? []) controls.push({ act: b.act, label: b.label, tab })
    for (const row of group.rows ?? []) for (const b of row) controls.push({ act: b.act, label: b.label ?? b.id, tab })
  }
}

/**
 * Rendered by Ribbon.tsx as <select> dropdowns, not buttons. Their change handler dispatches
 * `font.setFamily` / `font.setSize` with a value, so the bare act id is never run — those two
 * commands are covered separately below.
 */
const SELECT_RENDERED = new Set(['font.family', 'font.size'])

const unique = [...new Map(controls.map((c) => [c.act, c])).values()].filter(
  (c) => c.act !== 'noop' && !SELECT_RENDERED.has(c.act)
)

const failures: string[] = []
const refusals: string[] = []
let ok = 0

for (const control of unique) {
  useToastStore.setState({ toasts: [] })
  try {
    await runRibbonAction(control.act)
    await settled()
  } catch (err) {
    failures.push(`${control.tab} › ${control.label} (${control.act}) THREW: ${(err as Error).message}`)
    continue
  }

  const toasts = useToastStore.getState().toasts.map((t) => t.message)
  const generic = toasts.find((m) => m.includes('isn’t implemented yet') || m.includes("isn't implemented yet"))

  if (generic) {
    if (DELIBERATE_REFUSALS.has(control.act)) refusals.push(`${control.label} (${control.act})`)
    else failures.push(`${control.tab} › ${control.label} (${control.act}) → generic "not implemented" toast`)
    continue
  }
  if (DELIBERATE_REFUSALS.has(control.act)) {
    refusals.push(`${control.label} (${control.act}) — ${toasts[0] ?? 'no message'}`)
    continue
  }
  ok++
}

console.log(`Ribbon controls checked: ${unique.length}`)
console.log(`  reached a handler:     ${ok}`)
console.log(`  deliberate refusals:   ${refusals.length}`)
for (const r of refusals) console.log(`      · ${r}`)

// The two dropdowns dispatch a command plus a value; check that path explicitly.
for (const [command, payload] of [
  ['font.setFamily', 'Arial'],
  ['font.setSize', 14]
] as const) {
  useToastStore.setState({ toasts: [] })
  await handleEditorCommand(editor as never, command, payload)
  const toasts = useToastStore.getState().toasts.map((t) => t.message)
  if (toasts.some((m) => m.includes('implemented yet'))) {
    failures.push(`Font dropdown → ${command} is not handled`)
  } else ok++
}

console.log(`  font dropdowns:        2`)

if (failures.length > 0) {
  console.error(`\n${failures.length} UNREACHABLE CONTROL(S):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

console.log('\nALL PASS — every ribbon control reaches a handler.')
