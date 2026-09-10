import type { Editor } from '@tiptap/core'
import { useDocumentStore } from '../../store/documentStore'
import { useUiStore } from '../../store/uiStore'
import { useCommentStore } from '../../store/commentStore'
import { useTrackChangesStore } from '../../store/trackChangesStore'
import { useToastStore, notImplemented } from '../../common/toastStore'
import { insertComment } from '../insertComment'
import { pick } from './prompts'

const toast = (msg: string, tone: 'info' | 'warn' | 'error' = 'info'): void =>
  useToastStore.getState().push(msg, tone)

const LANGUAGES = ['English (US)', 'English (UK)', 'German', 'French', 'Spanish', 'Japanese'] as const

/** Ordered tracked changes, so Previous/Next can walk them by document position. */
function orderedChanges(): ReturnType<typeof useTrackChangesStore.getState>['changes'] {
  return [...useTrackChangesStore.getState().changes].sort((a, b) => a.from - b.from)
}

function gotoChange(editor: Editor, direction: 1 | -1): void {
  const changes = orderedChanges()
  if (changes.length === 0) {
    toast('No tracked changes in this document.')
    return
  }
  const cursor = editor.state.selection.from
  const next =
    direction === 1
      ? changes.find((c) => c.from > cursor) ?? changes[0]
      : [...changes].reverse().find((c) => c.from < cursor) ?? changes[changes.length - 1]
  editor.commands.setTextSelection({ from: next.from, to: next.to })
  editor.commands.scrollIntoView()
  toast(`${next.kind === 'insertion' ? 'Inserted' : 'Deleted'} by ${next.authorName}: "${next.text.slice(0, 40)}"`)
}

/** The tracked change under the cursor, if any. */
function changeAtCursor(editor: Editor): ReturnType<typeof orderedChanges>[number] | undefined {
  const pos = editor.state.selection.from
  return orderedChanges().find((c) => pos >= c.from && pos <= c.to)
}

/** The comment mark under the cursor, if any. */
function commentIdAtCursor(editor: Editor): string | null {
  const id = editor.getAttributes('comment')?.commentId
  return id ? String(id) : null
}

export async function handleReviewCommand(editor: Editor, command: string): Promise<boolean> {
  const ui = useUiStore.getState()
  const doc = useDocumentStore.getState()

  switch (command) {
    case 'review.wordCount': {
      const words = editor.storage.characterCount?.words?.() ?? 0
      const chars = editor.storage.characterCount?.characters?.() ?? 0
      const { from, to, empty } = editor.state.selection
      const selected = empty ? 0 : editor.state.doc.textBetween(from, to).trim().split(/\s+/).filter(Boolean).length
      window.alert(
        `${words} words\n${chars} characters${selected ? `\n\n${selected} words in the selection` : ''}`
      )
      return true
    }

    case 'review.spelling': {
      const on = doc.toggleSpellcheck()
      toast(`Spell check ${on ? 'on' : 'off'} — misspellings are underlined as you type.`)
      return true
    }

    case 'review.readAloud': {
      const synth = window.speechSynthesis
      const Utterance = window.SpeechSynthesisUtterance
      // Both halves of the API are needed; check them together rather than assuming the
      // constructor exists because the synthesiser does.
      if (!synth || !Utterance) {
        notImplemented('Read aloud')
        return true
      }
      if (synth.speaking) {
        synth.cancel()
        toast('Stopped reading.')
        return true
      }
      const { from, to, empty } = editor.state.selection
      const text = empty
        ? editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', ' ')
        : editor.state.doc.textBetween(from, to, '\n', ' ')
      if (!text.trim()) {
        toast('Nothing to read.')
        return true
      }
      synth.speak(new Utterance(text))
      toast('Reading aloud — press Read aloud again to stop.')
      return true
    }

    case 'review.thesaurus': {
      // Shipping a word list would mean shipping a dictionary licence, and inventing
      // synonyms for a regulatory document would be worse than offering nothing.
      const { from, to, empty } = editor.state.selection
      const word = empty ? '' : editor.state.doc.textBetween(from, to).trim()
      toast(
        word
          ? `No thesaurus is connected, so "${word}" cannot be looked up.`
          : 'No thesaurus is connected — this needs a licensed dictionary source.',
        'warn'
      )
      return true
    }

    case 'review.translate':
      toast('Translation isn’t available — it would send document text to an external service.', 'warn')
      return true

    case 'review.language': {
      const choice = await pick('Proofing language', LANGUAGES, doc.language as (typeof LANGUAGES)[number])
      if (!choice) return true
      doc.setLanguage(choice)
      toast(`Proofing language: ${choice}`)
      return true
    }

    case 'review.restrictEditing': {
      const on = doc.toggleRestrictEditing()
      toast(on ? 'Editing restricted — the document is read-only.' : 'Editing unrestricted.')
      return true
    }

    case 'review.blockAuthors': {
      // Who may edit is decided by folder access on the server, which is the control that
      // actually holds. Send the user there instead of adding a second, weaker switch.
      ui.setTreeTab('project')
      toast('Author access is managed per folder — open the folder’s Manage access dialog in the navigator.')
      return true
    }

    case 'review.compare':
    case 'review.combine': {
      // The server already diffs and three-way merges revisions; the Changes dock is the UI
      // for it, so route there rather than duplicating the comparison.
      if (!doc.documentId) {
        toast('Compare works on server documents — open one from the navigator.')
        return true
      }
      ui.setDock('proposals', { open: true })
      toast(
        command === 'review.compare'
          ? 'Showing revision differences in the Changes panel.'
          : 'Open proposals merge into the current revision from the Changes panel.'
      )
      return true
    }

    case 'comment.new':
      insertComment(editor)
      return true

    case 'comment.delete': {
      const id = commentIdAtCursor(editor)
      if (!id) {
        toast('Put the cursor inside a comment first.')
        return true
      }
      void useCommentStore.getState().removeComment(id)
      toast('Comment deleted.')
      return true
    }

    case 'comment.prev':
    case 'comment.next': {
      const comments = useCommentStore.getState().comments
      if (comments.length === 0) {
        toast('No comments in this document.')
        return true
      }
      const positions: Array<{ id: string; from: number; to: number }> = []
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return
        const mark = node.marks.find((m) => m.type.name === 'comment')
        if (mark) positions.push({ id: String(mark.attrs.commentId), from: pos, to: pos + (node.text?.length ?? 0) })
      })
      if (positions.length === 0) {
        toast('Comments exist but their anchors are missing from the text.')
        return true
      }
      const cursor = editor.state.selection.from
      const target =
        command === 'comment.next'
          ? positions.find((p) => p.from > cursor) ?? positions[0]
          : [...positions].reverse().find((p) => p.from < cursor) ?? positions[positions.length - 1]
      editor.commands.setTextSelection({ from: target.from, to: target.to })
      editor.commands.scrollIntoView()
      ui.setDock('comments', { open: true })
      const body = comments.find((c) => c.id === target.id)
      if (body) toast(`${body.authorName}: ${body.body}`)
      return true
    }

    case 'track.accept':
    case 'track.reject': {
      const change = changeAtCursor(editor) ?? orderedChanges()[0]
      if (!change) {
        toast('No tracked changes to resolve.')
        return true
      }
      const store = useTrackChangesStore.getState()
      if (command === 'track.accept') store.acceptChange(change.id)
      else store.rejectChange(change.id)
      toast(`${command === 'track.accept' ? 'Accepted' : 'Rejected'} ${change.kind} by ${change.authorName}.`)
      return true
    }

    case 'track.next':
      gotoChange(editor, 1)
      return true
    case 'track.prev':
      gotoChange(editor, -1)
      return true

    case 'track.allMarkup':
    case 'track.showMarkup': {
      const mode = ui.cycleMarkupMode()
      toast(
        { all: 'Showing all markup', simple: 'Simple markup — changes shown as final text', none: 'Markup hidden' }[
          mode
        ]
      )
      return true
    }

    case 'track.reviewingPane':
      ui.setDock('comments', { open: true })
      return true

    default:
      return false
  }
}
