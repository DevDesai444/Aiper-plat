import { useEffect, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TextAlign from '@tiptap/extension-text-align'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import LinkExtension from '@tiptap/extension-link'
import { PositionedImage } from './extensions/imageAttributes'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import CharacterCount from '@tiptap/extension-character-count'
import Placeholder from '@tiptap/extension-placeholder'

import { StyledParagraph } from './extensions/paragraphStyle'
import { Indent } from './extensions/indent'
import { PageBreak } from './extensions/pageBreak'
import { FontAttributes } from './extensions/fontAttributes'
import { Insertion, Deletion } from './extensions/trackChangeMarks'
import { TrackChangesPlugin } from './extensions/trackChangesPlugin'
import { CommentMark } from './extensions/comment'
import { handleEditorCommand } from './commandHandler'
import { registerEditorCommandHandler, setActiveEditor } from '../ribbon/editorCommandRegistry'
import { useOutlineSync } from './useOutlineSync'
import { useEditorStats } from './useEditorStats'
import { useTrackChangesSync } from './useTrackChangesSync'
import { useDocumentIO } from './useDocumentIO'
import { registerDocumentSnapshotProvider } from './documentSnapshot'
import { insertImage } from './insertImage'
import { useCommentStore } from '../store/commentStore'
import { useDocumentStore } from '../store/documentStore'
import { useUiStore } from '../store/uiStore'
import { useReferencesStore } from '../store/referencesStore'
import { useComplianceStore } from '../store/complianceStore'
import { useServerDocsStore } from '../store/serverDocsStore'
import { useServerDocument } from './useServerDocument'
import FindReplaceBar from './FindReplaceBar'
import './editor.css'

export default function EditorCanvas(): React.JSX.Element {
  const [findState, setFindState] = useState<'closed' | 'find' | 'replace'>('closed')
  const fileName = useDocumentStore((s) => s.fileName)
  const filePath = useDocumentStore((s) => s.filePath)
  const zoom = useDocumentStore((s) => s.zoom)
  const markDirty = useDocumentStore((s) => s.markDirty)
  const pendingOpenPath = useDocumentStore((s) => s.pendingOpenPath)
  const clearPendingOpen = useDocumentStore((s) => s.clearPendingOpen)
  const headerText = useDocumentStore((s) => s.headerText)
  const footerText = useDocumentStore((s) => s.footerText)
  const resetToken = useDocumentStore((s) => s.resetToken)
  const checkDocument = useComplianceStore((s) => s.checkDocument)
  const watermark = useDocumentStore((s) => s.watermark)
  const pageColor = useDocumentStore((s) => s.pageColor)
  const pageBorders = useDocumentStore((s) => s.pageBorders)
  const lineNumbers = useDocumentStore((s) => s.lineNumbers)
  const restrictEditing = useDocumentStore((s) => s.restrictEditing)
  const spellcheck = useDocumentStore((s) => s.spellcheck)
  const accent = useDocumentStore((s) => s.accent)
  const paragraphSpacingPt = useDocumentStore((s) => s.paragraphSpacingPt)
  const shadowEffects = useDocumentStore((s) => s.shadowEffects)
  const columns = useDocumentStore((s) => s.pageSetup.columns)
  const pageView = useUiStore((s) => s.pageView)
  const showRuler = useUiStore((s) => s.showRuler)
  const showGridlines = useUiStore((s) => s.showGridlines)
  const markupMode = useUiStore((s) => s.markupMode)
  const searchToken = useUiStore((s) => s.searchToken)
  const footnotes = useReferencesStore((s) => s.footnotes)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ paragraph: false }),
      StyledParagraph,
      Indent,
      PageBreak,
      FontAttributes,
      Insertion,
      Deletion,
      TrackChangesPlugin,
      CommentMark,
      Underline,
      Subscript,
      Superscript,
      Color,
      Highlight.configure({ multicolor: true }),
      LinkExtension.configure({ openOnClick: false }),
      PositionedImage,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start typing…' })
    ],
    content: '<p></p>',
    onUpdate: () => markDirty(),
    editorProps: {
      attributes: { class: 'editor-page-content' }
    }
  })

  const { save: saveLocal, openFromPath, exportPdf, printDocument } = useDocumentIO(editor)
  const { saveToServer, reloadFromServer } = useServerDocument(editor)
  const documentId = useDocumentStore((s) => s.documentId)
  const lockedByOther = useDocumentStore((s) => s.lockedByOther)
  const pendingUpdate = useServerDocsStore((s) => s.pendingUpdate)

  // Server-backed documents save through the server (locking + revisions + audit);
  // a purely local document still saves straight to a .docx on disk.
  const save = documentId ? saveToServer : saveLocal
  useOutlineSync(editor)
  useEditorStats(editor)
  useTrackChangesSync(editor)

  useEffect(() => {
    if (!editor) return
    return useCommentStore.getState().registerDeleteHandler((id) => {
      editor.chain().focus().unsetCommentById(id).run()
    })
  }, [editor])

  // Lets the compliance panel analyse the document as it stands, not the last saved copy.
  useEffect(() => {
    if (!editor) return
    return registerDocumentSnapshotProvider(() => {
      const { fileName, pageSetup, headerText, footerText } = useDocumentStore.getState()
      const asDoc = (text: string): JSONContent => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      })
      return {
        title: fileName ?? 'Untitled document',
        content: editor.getJSON(),
        pageSetup,
        header: headerText ? asDoc(headerText) : null,
        footer: footerText ? asDoc(footerText) : null
      }
    })
  }, [editor])

  useEffect(() => {
    if (!editor) return
    setActiveEditor('main')
    return registerEditorCommandHandler('main', (command, payload) => {
      if (command === 'save') {
        void save()
        return
      }
      if (command === 'print') {
        void printDocument()
        return
      }
      if (command === 'exportPdf') {
        void exportPdf()
        return
      }
      if (command === 'compliance.checkDocument') {
        // The store resolves what to send: the saved file when it is clean, the live editor
        // state otherwise.
        void checkDocument(filePath ?? fileName ?? 'untitled')
        return
      }
      if (command === 'edit.find') {
        setFindState('find')
        return
      }
      if (command === 'edit.replace') {
        setFindState('replace')
        return
      }
      if (command === 'insert.image') {
        insertImage(editor)
        return
      }
      return handleEditorCommand(editor, command, payload)
    })
  }, [editor, save, exportPdf, printDocument, checkDocument, filePath, fileName])

  useEffect(() => {
    if (pendingOpenPath && editor) {
      void openFromPath(pendingOpenPath).then(() => clearPendingOpen())
    }
  }, [pendingOpenPath, editor, openFromPath, clearPendingOpen])

  // Blank the editor when a new document is started. Comments are keyed to marks in the
  // old document, so they have to go with it.
  useEffect(() => {
    if (!editor || resetToken === 0) return
    editor.commands.setContent('<p></p>')
    useCommentStore.getState().clear()
  }, [editor, resetToken])

  // Read mode and Restrict editing both make the document read-only; a server lock held by
  // someone else does too. Whichever is in force, the editor must actually refuse edits.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!restrictEditing && pageView !== 'read' && !lockedByOther)
  }, [editor, restrictEditing, pageView, lockedByOther])

  useEffect(() => {
    if (!editor) return
    editor.setOptions({ editorProps: { attributes: { class: 'editor-page-content', spellcheck: String(spellcheck) } } })
  }, [editor, spellcheck])

  // The title bar's Search button opens the same find bar as Ctrl/Cmd-F.
  useEffect(() => {
    if (searchToken > 0) setFindState('find')
  }, [searchToken])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setFindState('find')
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  if (!editor) return <div className="editor-scroll" />

  return (
    <div className="editor-scroll">
      {lockedByOther && (
        <div className="editor-banner editor-banner--locked">
          <strong>Read only.</strong> {lockedByOther} has this document checked out. Your changes cannot be saved until
          they check it back in.
        </div>
      )}

      {pendingUpdate && pendingUpdate.documentId === documentId && (
        <div className="editor-banner editor-banner--update">
          <span>
            <strong>{pendingUpdate.savedBy}</strong> saved revision {pendingUpdate.revision} of this document.
          </span>
          <button type="button" onClick={() => void reloadFromServer()}>
            Reload
          </button>
        </div>
      )}

      {findState !== 'closed' && (
        <FindReplaceBar editor={editor} showReplace={findState === 'replace'} onClose={() => setFindState('closed')} />
      )}

      {showRuler && (
        <div className="editor-ruler" aria-hidden>
          {Array.from({ length: 21 }, (_, i) => (
            <span key={i} className={i % 5 === 0 ? 'editor-ruler-tick is-major' : 'editor-ruler-tick'}>
              {i % 5 === 0 ? i : ''}
            </span>
          ))}
        </div>
      )}

      <div
        className={[
          'editor-page',
          `editor-page--${pageView}`,
          showGridlines ? 'is-gridlines' : '',
          lineNumbers ? 'is-linenumbers' : '',
          pageBorders ? 'is-bordered' : '',
          shadowEffects ? 'is-shadowed' : '',
          `markup-${markupMode}`
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          transform: `scale(${zoom / 100})`,
          ...(pageColor ? { background: pageColor } : {}),
          ['--accent' as string]: accent,
          ['--para-spacing' as string]: `${paragraphSpacingPt}pt`,
          ...(columns > 1 ? { ['--columns' as string]: String(columns) } : {})
        }}
      >
        {watermark && <div className="editor-watermark">{watermark}</div>}
        {headerText && <div className="editor-page-header">{headerText}</div>}
        <EditorContent editor={editor} />
        {footnotes.length > 0 && (
          <div className="editor-footnotes">
            {footnotes.map((f) => (
              <div key={f.id} className="editor-footnote">
                <sup>{f.number}</sup> {f.text}
              </div>
            ))}
          </div>
        )}
        {footerText && <div className="editor-page-footer">{footerText.replace('{page}', '1')}</div>}
      </div>
    </div>
  )
}
