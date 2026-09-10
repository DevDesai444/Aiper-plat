import { Extension } from '@tiptap/core'

const MAX_INDENT = 8
const INDENTABLE_TYPES = ['paragraph', 'heading']

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType
      outdent: () => ReturnType
    }
  }
}

export const Indent = Extension.create({
  name: 'indent',

  addGlobalAttributes() {
    return [
      {
        types: INDENTABLE_TYPES,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => Number(element.style.marginLeft?.replace('px', '') || 0) / 24,
            renderHTML: (attributes) => {
              const indent = Number(attributes.indent) || 0
              if (!indent) return {}
              return { style: `margin-left: ${indent * 24}px` }
            }
          },
          lineSpacing: {
            default: 1,
            parseHTML: (element) => Number(element.style.lineHeight) || 1,
            renderHTML: (attributes) => {
              const lineSpacing = Number(attributes.lineSpacing) || 1
              if (lineSpacing === 1) return {}
              return { style: `line-height: ${lineSpacing}` }
            }
          }
        }
      }
    ]
  },

  addCommands() {
    return {
      indent:
        () =>
        ({ editor, commands }) => {
          const type = editor.state.selection.$from.parent.type.name
          if (!INDENTABLE_TYPES.includes(type)) return false
          const current = Number(editor.getAttributes(type).indent) || 0
          return commands.updateAttributes(type, { indent: Math.min(current + 1, MAX_INDENT) })
        },
      outdent:
        () =>
        ({ editor, commands }) => {
          const type = editor.state.selection.$from.parent.type.name
          if (!INDENTABLE_TYPES.includes(type)) return false
          const current = Number(editor.getAttributes(type).indent) || 0
          return commands.updateAttributes(type, { indent: Math.max(current - 1, 0) })
        }
    }
  }
})
