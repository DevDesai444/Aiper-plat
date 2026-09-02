import type { Editor } from '@tiptap/core'
import { useCommentStore } from '../store/commentStore'
import { askText } from '../common/promptStore'

export async function insertComment(editor: Editor): Promise<void> {
  const { from, to, empty } = editor.state.selection
  if (empty) {
    window.alert('Select some text first to attach a comment to it.')
    return
  }
  const body = await askText('Comment', '', { confirmLabel: 'Add comment' })
  if (!body?.trim()) return

  const quotedText = editor.state.doc.textBetween(from, to)
  const commentId = `cm-${Date.now()}`
  const timestamp = new Date().toISOString()

  editor.chain().focus().setComment({ commentId, authorName: 'You', timestamp }).run()
  void useCommentStore
    .getState()
    .addComment({ id: commentId, quotedText, body, authorName: 'You', timestamp, resolved: false })
}

export function registerCommentDeleteHandler(editor: Editor): () => void {
  const unregister = useCommentStore.getState().registerDeleteHandler
  unregister((id) => {
    editor.chain().focus().unsetCommentById(id).run()
  })
  return () => {}
}
