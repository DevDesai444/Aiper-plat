import Paragraph from '@tiptap/extension-paragraph'

export type ParagraphStyleName = 'ctdSection' | 'reference' | 'tableCaption' | null

/**
 * Extends the stock paragraph node with a `styleName` attribute so the domain-specific
 * styles from the mockup's Styles gallery (CTD section, Reference, Table caption) round-trip
 * through both the editor and the docx import/export style map (see
 * src/main/services/docx/import.ts's STYLE_MAP, which maps the same class names back in).
 */
export const StyledParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      styleName: {
        default: null,
        parseHTML: (element) => {
          if (element.classList.contains('ctd-section')) return 'ctdSection'
          if (element.classList.contains('reference')) return 'reference'
          if (element.classList.contains('table-caption')) return 'tableCaption'
          return null
        },
        renderHTML: (attributes) => {
          const styleName = attributes.styleName as ParagraphStyleName
          if (!styleName) return {}
          const className = { ctdSection: 'ctd-section', reference: 'reference', tableCaption: 'table-caption' }[styleName]
          return { class: className }
        }
      }
    }
  }
})
