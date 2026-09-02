import type { Editor } from '@tiptap/core'

export interface FindMatch {
  from: number
  to: number
}

/** Concatenates the doc's text nodes with their absolute ProseMirror positions, then
 *  regex-searches the concatenation — text node boundaries don't line up 1:1 with plain
 *  string indices, so positions are tracked alongside each character run as we walk. */
export function findAll(editor: Editor, query: string): FindMatch[] {
  if (!query) return []
  const matches: FindMatch[] = []
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped, 'gi')

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    let match: RegExpExecArray | null
    re.lastIndex = 0
    while ((match = re.exec(node.text))) {
      matches.push({ from: pos + match.index, to: pos + match.index + match[0].length })
      if (match[0].length === 0) re.lastIndex++
    }
  })

  return matches
}

export function selectMatch(editor: Editor, match: FindMatch): void {
  editor.chain().focus().setTextSelection(match).scrollIntoView().run()
}

export function replaceMatch(editor: Editor, match: FindMatch, replacement: string): void {
  editor.chain().focus().insertContentAt(match, replacement).run()
}

export function replaceAll(editor: Editor, query: string, replacement: string): number {
  const matches = findAll(editor, query)
  // Replace back-to-front so earlier positions stay valid as later ones shrink/grow.
  for (let i = matches.length - 1; i >= 0; i--) {
    replaceMatch(editor, matches[i], replacement)
  }
  return matches.length
}
