import TextStyle from '@tiptap/extension-text-style'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontAttributes: {
      setFontFamily: (fontFamily: string) => ReturnType
      unsetFontFamily: () => ReturnType
      setFontSize: (fontSizePt: number) => ReturnType
      unsetFontSize: () => ReturnType
    }
  }
}

/** Extends Tiptap's TextStyle mark with fontFamily/fontSize, rather than pulling in
 *  separate community packages for each — both render onto the same inline `style` mark
 *  and both are read by docx export's runsFromInline (src/main/services/docx/export.ts). */
export const FontAttributes = TextStyle.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fontFamily: {
        default: null,
        parseHTML: (element) => element.style.fontFamily?.replace(/['"]/g, '') || null,
        renderHTML: (attributes) => {
          if (!attributes.fontFamily) return {}
          return { style: `font-family: ${attributes.fontFamily}` }
        }
      },
      fontSize: {
        default: null,
        parseHTML: (element) => (element.style.fontSize ? parseInt(element.style.fontSize, 10) : null),
        renderHTML: (attributes) => {
          if (!attributes.fontSize) return {}
          return { style: `font-size: ${attributes.fontSize}pt` }
        }
      }
    }
  },

  addCommands() {
    return {
      setFontFamily:
        (fontFamily: string) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontFamily }).run(),
      unsetFontFamily:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontFamily: null }).removeEmptyTextStyle().run(),
      setFontSize:
        (fontSizePt: number) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: fontSizePt }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run()
    }
  }
})
