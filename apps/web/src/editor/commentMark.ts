import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * `comment` — inline mark that anchors a REST comment thread to a range
 * of text.
 *
 * Data model
 *   The mark carries a single `markId` attribute (a client-generated
 *   uuid). Bodies + authorship + resolved state live in the `comments`
 *   table on the server, keyed by `(document_id, mark_id)`. The mark
 *   itself is stored in the shared Y.Doc, so:
 *
 *     • The highlight syncs to peers live via CRDT — no polling.
 *     • It persists in `document_snapshots` alongside the rest of the
 *       document, so the highlight is durable across sessions.
 *     • Round-tripping the highlight through Yjs never loses the id;
 *       every reload sees the same `markId` on the same range.
 *
 * Serialisation
 *   Renders as `<span data-comment-id="…" class="comment-highlight">`,
 *   which is what the panel selects on to scroll the highlight into
 *   view. The mark is inclusive-false: typing at the edge of a
 *   commented run does NOT extend the highlight — otherwise a
 *   character appended at the end would carry the mark into unrelated
 *   text and orphan the thread's textual anchor.
 *
 * Schema is forever
 *   The mark name `comment` and the attribute name `markId` are
 *   permanent on-wire keys. Renaming either would silently orphan
 *   every existing highlight across every stored document: the new
 *   client would fail to find the old marks in the Yjs delta and
 *   render the doc without the highlights, and — on the next save —
 *   overwrite the snapshot with the highlight-less state. Additive
 *   changes (new attributes, new marks) are safe; renames are not.
 */
export const CommentMark = Mark.create({
  name: 'comment',

  // A commented range should not extend when the user types at its
  // end — the highlight anchors to a specific text span, and
  // sprawling would silently drag the thread onto unrelated text.
  inclusive: false,

  // Allow overlap with any other mark: a bolded phrase can be
  // commented, a commented phrase can be italicised, and two
  // independent threads can overlap on the same text run (each with
  // its own `markId`). The extra info in `excludes: ''` says "this
  // mark excludes no other marks", i.e. free overlap.
  excludes: '',

  addAttributes() {
    return {
      markId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) =>
          attrs.markId ? { 'data-comment-id': attrs.markId } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'comment-highlight' }),
      0,
    ]
  },
})
