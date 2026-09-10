import Image from '@tiptap/extension-image'

export type ImageWrap = 'inline' | 'left' | 'right'
export type ImageAlign = 'left' | 'center' | 'right'

/**
 * Adds the placement attributes the Layout → Arrange group needs.
 *
 * Everything renders through inline styles on the `<img>` itself, so a positioned picture
 * round-trips through the same HTML the docx importer already reads, and an older document
 * without these attributes simply falls back to an inline, unrotated image.
 */
export const PositionedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      wrap: {
        default: 'inline' as ImageWrap,
        parseHTML: (el) => (el as HTMLElement).dataset.wrap ?? 'inline',
        renderHTML: (attrs) => {
          const wrap = attrs.wrap as ImageWrap
          if (!wrap || wrap === 'inline') return {}
          return { 'data-wrap': wrap, style: `float: ${wrap}; margin: ${wrap === 'left' ? '4px 12px 4px 0' : '4px 0 4px 12px'}` }
        }
      },
      align: {
        default: null as ImageAlign | null,
        parseHTML: (el) => (el as HTMLElement).dataset.align ?? null,
        renderHTML: (attrs) => {
          const align = attrs.align as ImageAlign | null
          if (!align) return {}
          const margin = { left: '0 auto 0 0', center: '0 auto', right: '0 0 0 auto' }[align]
          return { 'data-align': align, style: `display: block; margin: ${margin}` }
        }
      },
      rotate: {
        default: 0,
        parseHTML: (el) => Number((el as HTMLElement).dataset.rotate ?? 0),
        renderHTML: (attrs) => {
          const rotate = Number(attrs.rotate) || 0
          if (!rotate) return {}
          return { 'data-rotate': String(rotate), style: `transform: rotate(${rotate}deg)` }
        }
      },
      zIndex: {
        default: 0,
        parseHTML: (el) => Number((el as HTMLElement).dataset.z ?? 0),
        renderHTML: (attrs) => {
          const z = Number(attrs.zIndex) || 0
          if (!z) return {}
          return { 'data-z': String(z), style: `position: relative; z-index: ${z}` }
        }
      },
      width: {
        default: null as number | null,
        parseHTML: (el) => {
          const w = (el as HTMLImageElement).width
          return w > 0 ? w : null
        },
        renderHTML: (attrs) => (attrs.width ? { width: String(attrs.width) } : {})
      }
    }
  }
})
