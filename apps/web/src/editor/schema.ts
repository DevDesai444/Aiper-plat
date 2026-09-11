import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import type { Extensions } from '@tiptap/core'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

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
/**
 * Runtime bits `buildEditorExtensions` needs.
 *
 *   • `ydoc` — required, drives the Collaboration extension.
 *   • `cursor` — optional. Present ⇒ enable remote cursors via
 *     `@tiptap/extension-collaboration-cursor`. The extension is
 *     **decoration-only** — it never persists to the Y.Doc's shared
 *     state, so the "SCHEMA IS FOREVER" invariant above does not
 *     apply to it: adding, removing, or reconfiguring it is safe
 *     across versions.
 */
export interface EditorCollabRuntime {
  ydoc: Y.Doc
  cursor?: {
    awareness: Awareness
    user: { name: string; color: string }
  }
}

export function buildEditorExtensions(rt: EditorCollabRuntime): Extensions {
  const extensions: Extensions = [
    // history: false — Yjs owns undo via Collaboration. See above.
    StarterKit.configure({ history: false }),
    Collaboration.configure({ document: rt.ydoc, field: Y_DOC_FRAGMENT_FIELD }),
  ]
  if (rt.cursor) {
    extensions.push(
      CollaborationCursor.configure({
        // The extension reads `provider.awareness`. Passing a bare
        // `{ awareness }` object rather than a full HocuspocusProvider
        // works because that field is all the extension touches.
        provider: { awareness: rt.cursor.awareness } as unknown as {
          awareness: Awareness
        },
        user: rt.cursor.user,
      }),
    )
  }
  return extensions
}
