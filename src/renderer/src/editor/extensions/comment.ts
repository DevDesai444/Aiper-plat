import { Mark, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: (attrs: { commentId: string; authorName: string; timestamp: string }) => ReturnType
      unsetCommentById: (commentId: string) => ReturnType
    }
  }
}

/** Marks a text range as commented; the comment body itself lives in commentStore, keyed
 *  by commentId, so the mark only needs to carry the id + light provenance for rendering. */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,

  addAttributes() {
    // Null defaults, not factories — Tiptap evaluates a function `default` once at
    // schema-build time, which would freeze one timestamp for the entire session.
    // insertComment.ts passes real values explicitly on every comment.
    return {
      commentId: { default: null },
      authorName: { default: null },
      timestamp: { default: null }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-comment-id': HTMLAttributes.commentId }), 0]
  },

  addCommands() {
    return {
      setComment:
        (attrs) =>
        ({ chain }) =>
          chain().setMark('comment', attrs).run(),
      unsetCommentById:
        (commentId: string) =>
        ({ tr, state, dispatch }) => {
          state.doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === 'comment' && mark.attrs.commentId === commentId) {
                tr.removeMark(pos, pos + node.nodeSize, mark.type)
              }
            })
          })
          if (dispatch) dispatch(tr)
          return true
        }
    }
  }
})
