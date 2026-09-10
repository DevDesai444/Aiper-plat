import { Node, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: () => ReturnType
    }
  }
}

/**
 * An explicit, user-inserted page break. Renders as a thin marker in the continuous-scroll
 * editing view; maps to `break-after: page` in print CSS and a literal Word page-break run
 * on docx export (see the plan's pagination notes — this is the only kind of "page" the
 * editing surface models directly; real pagination happens at print/export time).
 */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div[data-page-break]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-break': 'true', class: 'page-break-marker' })]
  },

  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name })
    }
  }
})
