import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * Defaults are deliberately null, NOT factory functions. Tiptap resolves a function
 * `default` exactly once when it builds the schema (see getAttributesFromExtensions),
 * so `() => new Date().toISOString()` would freeze one timestamp for the whole session
 * and hand every insertion the same changeId — colliding IDs make accept/reject act on
 * the wrong range, and a frozen timestamp fails 21 CFR 11.10(e), which requires the
 * date and time of the operator entry. Real values are stamped per-edit in
 * editor/extensions/trackChangesPlugin.ts via newChangeAttrs().
 */
const authorAttrs = {
  authorId: { default: null },
  authorName: { default: null },
  timestamp: { default: null },
  changeId: { default: null }
}

/** Text inserted while track changes is on. Kept as a normal mark (not removed on
 *  accept) so accept = strip the mark, reject = delete the range — see
 *  editor/trackChangesPlugin.ts and store/trackChangesStore.ts. Exported to real Word
 *  tracked changes via docx's InsertedTextRun (src/main/services/docx/export.ts). */
export const Insertion = Mark.create({
  name: 'insertion',
  // Non-inclusive: an inclusive mark auto-continues into text typed next to it, which
  // would tag edits made with track changes OFF as tracked insertions. Continuation
  // while tracking is ON is handled deliberately in trackChangesPlugin.ts, which reuses
  // an adjacent change's attrs so continuous typing still reads as one change.
  inclusive: false,
  addAttributes() {
    return authorAttrs
  },
  parseHTML() {
    return [{ tag: 'ins' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'track-insertion' }), 0]
  }
})

/** Text "deleted" while track changes is on. The text stays in the document (struck
 *  through, excluded from word count) until the change is accepted (removes the text)
 *  or rejected (strips the mark). Exported as docx's DeletedTextRun. */
export const Deletion = Mark.create({
  name: 'deletion',
  inclusive: false,
  addAttributes() {
    return authorAttrs
  },
  parseHTML() {
    return [{ tag: 'del' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'track-deletion' }), 0]
  }
})
