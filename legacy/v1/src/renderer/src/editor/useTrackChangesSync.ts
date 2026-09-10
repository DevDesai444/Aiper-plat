import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import { useTrackChangesStore } from '../store/trackChangesStore'
import type { TrackedChange } from '../store/trackChangesStore'

function collect(editor: Editor): TrackedChange[] {
  const changes: TrackedChange[] = []
  let current: TrackedChange | null = null

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const mark = node.marks.find((m) => m.type.name === 'insertion' || m.type.name === 'deletion')
    if (!mark) {
      current = null
      return
    }
    const kind = mark.type.name as 'insertion' | 'deletion'
    const changeId = String(mark.attrs.changeId ?? `${kind}-${pos}`)
    if (current && current.id === changeId) {
      current.text += node.text
      current.to = pos + node.text.length
    } else {
      current = {
        id: changeId,
        kind,
        text: node.text,
        authorName: String(mark.attrs.authorName ?? 'You'),
        timestamp: String(mark.attrs.timestamp ?? ''),
        from: pos,
        to: pos + node.text.length
      }
      changes.push(current)
    }
  })

  return changes
}

export function useTrackChangesSync(editor: Editor | null): void {
  const setChanges = useTrackChangesStore((s) => s.setChanges)
  const registerHandlers = useTrackChangesStore((s) => s.registerHandlers)

  useEffect(() => {
    if (!editor) return

    const sync = (): void => setChanges(collect(editor))
    sync()
    editor.on('update', sync)
    editor.on('selectionUpdate', sync)

    registerHandlers(
      (id) => {
        // Accept: insertions keep their text (strip the mark); deletions are actually removed.
        const change = collect(editor).find((c) => c.id === id)
        if (!change) return
        if (change.kind === 'insertion') {
          editor.chain().setTextSelection({ from: change.from, to: change.to }).unsetMark('insertion').run()
        } else {
          editor.chain().deleteRange({ from: change.from, to: change.to }).run()
        }
      },
      (id) => {
        // Reject: insertions are removed; deletions are restored (strip the mark, keep text).
        const change = collect(editor).find((c) => c.id === id)
        if (!change) return
        if (change.kind === 'insertion') {
          editor.chain().deleteRange({ from: change.from, to: change.to }).run()
        } else {
          editor.chain().setTextSelection({ from: change.from, to: change.to }).unsetMark('deletion').run()
        }
      }
    )

    return () => {
      editor.off('update', sync)
      editor.off('selectionUpdate', sync)
    }
  }, [editor, setChanges, registerHandlers])
}
