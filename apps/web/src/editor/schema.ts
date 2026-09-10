import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import type { Extensions } from '@tiptap/core'
import type * as Y from 'yjs'

/**
 * ─── ⚠  IMMORTAL CONTRACT — DO NOT RENAME  ⚠ ──────────────────────────────
 *
 * The Yjs fragment field bound to TipTap's `Collaboration` extension.
 *
 * This string is the permanent on-wire content key for every document
 * Aiper stores. The server never inspects it — `saveSnapshot` treats
 * `Y.Doc` bytes as opaque and the WS server just relays updates. That
 * means the field name is a client-only convention, and a rename here
 * would silently orphan every existing document: the new client would
 * bind to a different, empty fragment inside the same `Y.Doc`, render
 * an empty page, and — worse — persist that empty state on next save,
 * overwriting the real content.
 *
 * If a schema-breaking migration ever becomes truly unavoidable, ship
 * it as a batched read-old-fragment / write-new-fragment migration
 * across every row of `document_snapshots`, coordinated with the
 * server. Never as a quiet literal edit here.
 */
export const Y_DOC_FRAGMENT_FIELD = 'default'

/**
 * ─── ⚠  SCHEMA IS FOREVER  ⚠ ──────────────────────────────────────────────
 *
 * The document schema of record — every node and mark type the editor
 * knows how to store. TipTap/ProseMirror schemas are additive-safe and
 * subtractive-dangerous:
 *
 *   • Adding a node or mark type in a later PR is backward-compatible.
 *     Old documents don't use it and open fine; new documents that use
 *     it will refuse to open in a client that lacks the extension, but
 *     we control the only client.
 *
 *   • Removing an extension orphans every document that used it —
 *     ProseMirror will either refuse to load the doc or silently strip
 *     the unknown marks/nodes, depending on the parse path. Both are
 *     data loss.
 *
 * Rule: this list grows PR-by-PR; nothing in it is removed or renamed
 * in place. Each addition ships alongside its ribbon action, its
 * round-trip test, and — for anything richer than a mark — a note on
 * how it round-trips through Y.js's `XmlFragment` shape.
 *
 * PR-1 floor: StarterKit's default nodes (paragraph, heading,
 * blockquote, code block, bullet list, ordered list, list item,
 * horizontal rule, hard break) and marks (bold, italic, strike, code).
 * StarterKit's `history` extension is DISABLED — the `Collaboration`
 * extension owns undo/redo through the Y.Doc's own history stack.
 * Enabling both would produce two competing undo stacks and, once the
 * local one rolls back writes the Y.Doc has already broadcast to
 * peers, corrupt the shared state.
 */
export function buildEditorExtensions(ydoc: Y.Doc): Extensions {
  return [
    // history: false — Yjs owns undo via Collaboration. See above.
    StarterKit.configure({ history: false }),
    Collaboration.configure({ document: ydoc, field: Y_DOC_FRAGMENT_FIELD }),
  ]
}
