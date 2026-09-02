import { useUiStore } from '../store/uiStore'
import { useDocumentStore } from '../store/documentStore'
import { runEditorCommand } from './editorCommandRegistry'
import { useToastStore } from '../common/toastStore'
import { useFolderStore } from '../store/folderStore'
import { useImportStore } from '../store/importStore'
import { uploadOne } from '../project/uploadDocument'
import { runWorkspaceAction } from './workspaceActions'

const toast = (msg: string, tone: 'info' | 'warn' | 'error' = 'info'): void =>
  useToastStore.getState().push(msg, tone)

/**
 * Actions the shell owns outright — window, view, session and navigation. Anything not matched
 * here is a document command and is forwarded to the mounted editor.
 *
 * There is deliberately no allow-list of editor prefixes any more. The previous version
 * forwarded only a fixed set (`mark.`, `font.`, `insert.`, …), so every command written
 * outside those prefixes — Margins, Orientation, Word count, New comment and the entire
 * References tab — was fully implemented in the editor yet still reported itself as unbuilt.
 * Forwarding by default means a command is reachable the moment it exists.
 */
export async function runRibbonAction(act: string): Promise<void> {
  const ui = useUiStore.getState()
  const doc = useDocumentStore.getState()

  switch (act) {
    case 'noop':
      return

    case 'file.new':
      if (doc.dirty && !window.confirm('You have unsaved changes. Discard them and start a new document?')) {
        return
      }
      doc.newDocument('Untitled document.docx')
      ui.setView('editor')
      return

    case 'file.save':
      runEditorCommand('save')
      return

    case 'file.print':
      runEditorCommand('print')
      return

    case 'file.exportPdf':
      runEditorCommand('exportPdf')
      return

    case 'file.open': {
      // Opening a single .docx into the editor. This used to share a case with folder.open and
      // so put up a *folder* picker, which is not what "Open" says it does.
      if (!window.aiper) return
      if (doc.dirty && !window.confirm('You have unsaved changes. Discard them and open another document?')) {
        return
      }
      const filePath = await window.aiper.fs.openFileDialog()
      if (!filePath) return
      ui.setView('editor')
      doc.requestOpen(filePath)
      return
    }

    case 'folder.open': {
      // A folder is a project, so opening one brings it in rather than just listing it. The
      // dialog confirms before anything is created, and adopts rather than duplicates a folder
      // that is already a GitHub repository.
      if (!window.aiper) return
      const rootPath = await window.aiper.fs.openFolderDialog()
      if (!rootPath) return
      await useImportStore.getState().begin(rootPath)
      return
    }

    case 'project.uploadDocument': {
      if (!window.aiper) return
      const folder = useFolderStore.getState().selectedFolder
      if (!folder) {
        toast('Pick the project folder to upload into first.', 'warn')
        return
      }
      const filePath = await window.aiper.fs.pickFileForUpload()
      if (!filePath) return
      await uploadOne(filePath, folder)
      return
    }

    case 'app.settings':
      ui.setView('settings')
      return

    case 'app.people': {
      // People are per-project, so this needs a project. There is no global user list.
      const folders = useFolderStore.getState()
      const target = folders.selectedFolder ?? (folders.folders.length === 1 ? folders.folders[0] : null)
      if (!target) {
        toast('Select a project first — people are added to a project, not to Aiper.', 'warn')
        return
      }
      folders.openPermissions(target.id, target.name)
      return
    }

    case 'compliance.checkDocument':
      ui.setDock('compliance', { open: true })
      runEditorCommand('compliance.checkDocument')
      return

    case 'compliance.checkFolder': {
      const folder = useFolderStore.getState().selectedFolder
      if (!folder) {
        toast('Select a folder in the left panel first.', 'warn')
        return
      }
      ui.setView('folder')
      return
    }

    case 'ai.open':
    case 'ai.askSelection':
    case 'ai.citeGuidance':
    case 'ai.precedentSearch':
      ui.setDock('chat', { open: true })
      return

    case 'assist.editor':
      ui.setDock('compliance', { open: true })
      runEditorCommand('compliance.checkDocument')
      return

    case 'track.toggle': {
      doc.toggleTrackChanges()
      toast(`Track changes ${useDocumentStore.getState().trackChangesEnabled ? 'on' : 'off'}`)
      return
    }

    // ── View tab ────────────────────────────────────────────────────────────────
    case 'view.printLayout':
      ui.setPageView('print')
      ui.setView('editor')
      return
    case 'view.readMode':
      ui.setPageView('read')
      ui.setView('editor')
      toast('Read mode — the document is read-only until you return to Print layout.')
      return
    case 'view.webLayout':
      ui.setPageView('web')
      ui.setView('editor')
      return
    case 'view.draft':
      ui.setPageView('draft')
      ui.setView('editor')
      return
    case 'view.outline':
      ui.setTreeTab('outline')
      if (!ui.leftOpen) ui.toggleLeft()
      return
    case 'view.ruler':
      ui.toggleRuler()
      return
    case 'view.gridlines':
      ui.toggleGridlines()
      return
    case 'view.navigationPane':
      ui.toggleLeft()
      return
    case 'view.zoom': {
      const next: number = { 100: 85, 85: 125, 125: 150, 150: 75 }[doc.zoom] ?? 100
      doc.setZoom(next)
      toast(`Zoom ${next}%`)
      return
    }
    case 'view.onePage':
      doc.setZoom(70)
      toast('Fitted one full page')
      return
    case 'view.multiPage':
      doc.setZoom(45)
      toast('Fitted multiple pages')
      return
    case 'view.pageWidth':
      doc.setZoom(115)
      toast('Fitted to page width')
      return

    // ── Handled by the workspace module (windows, reports, sharing, rulebook) ────
    case 'view.split':
    case 'view.sideBySide':
    case 'view.arrangeAll':
    case 'view.newWindow':
    case 'view.macros':
    case 'file.share':
    case 'file.protect':
    case 'workspace.rulebook':
    case 'workspace.history':
    case 'compliance.showMarkers':
    case 'compliance.findingReport':
    case 'compliance.resolveAll':
    case 'compliance.crossDoc':
    case 'compliance.estimateCost':
    case 'compliance.exportReport':
    case 'voice.dictate':
      await runWorkspaceAction(act)
      return

    default:
      // Everything else is a document command. If no editor is mounted the command cannot
      // run, so say why instead of doing nothing at all.
      if (!runEditorCommand(act)) {
        toast('Open a document first — that command acts on the document you are editing.', 'warn')
      }
  }
}
