import { create } from 'zustand'
import type {
  DocumentComplianceResult,
  DocumentRunUpdate,
  EngineStatus,
  FolderComplianceResult,
  FolderRunUpdate,
  ModelOption
} from '../../../main/services/compliance/ComplianceProvider'
import type { StoredDocument } from '../api/githubApi'
import { getDocumentSnapshot } from '../editor/documentSnapshot'
import { readBlob, readJson } from '../github/client'
import { useDocumentStore } from './documentStore'

interface ComplianceState {
  documentResult: DocumentComplianceResult | null
  documentLoading: boolean
  documentProgress: DocumentRunUpdate | null
  /** Set when a run fails, so the panel can say what went wrong instead of showing nothing. */
  documentError: string | null
  /** The document the current result describes; a new document invalidates it. */
  resultForDocId: string | null
  /** What is being checked, for the panel to name — the open document, or a file picked out
   *  of the project. Without it a PDF's findings would appear under the editor's title. */
  subjectLabel: string | null

  engineStatus: EngineStatus | null
  models: ModelOption[]
  selectedModel: string

  folderRun: FolderRunUpdate | null
  folderResult: FolderComplianceResult | null
  folderRunning: boolean

  refreshEngine: () => Promise<void>
  setSelectedModel: (model: string) => Promise<void>
  checkDocument: (docId: string) => Promise<void>
  /** Check any file — a PDF or .docx pulled out of the project, not just the open document. */
  checkProjectFile: (projectFullName: string, file: { path: string; name: string; sha: string }) => Promise<void>
  /** Check an Aiper document without opening it. Its stored form is JSON, which the engine
   *  cannot read, so it is rendered back to .docx on the way. */
  checkProjectDocument: (projectFullName: string, documentId: string, title: string) => Promise<void>
  /** Shared by both entry points: everything after "which bytes and what to call them". */
  runCheck: (subjectId: string, label: string, source: unknown) => Promise<void>
  clearDocumentResult: () => void
  applyDocumentProgress: (update: DocumentRunUpdate) => void
  checkFolder: (folderId: string, folderPath: string) => Promise<void>
  applyFolderProgress: (update: FolderRunUpdate) => void
}

/**
 * What to send the engine.
 *
 * A saved, unmodified document can go as the file on disk. Anything else — unsaved edits, a
 * document that has never been written, a server-backed document with no local path — has to
 * be exported from the editor first, or the findings would describe a different version of
 * the text than the one on screen.
 */
function documentSource():
  | { kind: 'file'; path: string }
  | { kind: 'model'; fileName: string; model: ReturnType<typeof getDocumentSnapshot> }
  | null {
  const { filePath, fileName, dirty } = useDocumentStore.getState()
  if (filePath && !dirty) return { kind: 'file', path: filePath }

  const snapshot = getDocumentSnapshot()
  if (!snapshot) return null
  return { kind: 'model', fileName: fileName ?? 'Untitled document.docx', model: snapshot }
}

export const useComplianceStore = create<ComplianceState>((set, get) => ({
  documentResult: null,
  documentLoading: false,
  documentProgress: null,
  documentError: null,
  resultForDocId: null,
  subjectLabel: null,

  engineStatus: null,
  models: [],
  selectedModel: '',

  folderRun: null,
  folderResult: null,
  folderRunning: false,

  refreshEngine: async () => {
    if (!window.aiper) return
    const [status, settings] = await Promise.all([
      window.aiper.compliance.engineStatus(),
      window.aiper.compliance.getEngineSettings()
    ])
    set({ engineStatus: status, selectedModel: settings.model })
    if (status.reachable) {
      const roster = await window.aiper.compliance.listModels()
      set({
        models: roster.models,
        selectedModel: settings.model || roster.default
      })
    }
  },

  setSelectedModel: async (model) => {
    if (!window.aiper) return
    await window.aiper.compliance.setEngineSettings({ model })
    set({ selectedModel: model })
  },

  checkDocument: async (docId) => {
    const source = documentSource()
    if (!source) {
      set({ documentError: 'No document is open in the editor.', documentLoading: false })
      return
    }
    const { fileName } = useDocumentStore.getState()
    await get().runCheck(docId, fileName ?? 'Document', source)
  },

  checkProjectFile: async (projectFullName, file) => {
    set({
      documentLoading: true,
      documentError: null,
      documentResult: null,
      documentProgress: null,
      resultForDocId: file.path,
      subjectLabel: file.name
    })
    try {
      // Pulled from the project rather than the disk: the folder it was imported from may not
      // be on this machine at all, and a colleague opening the same project must get the same
      // bytes checked.
      const base64 = await readBlob(projectFullName, file.sha)
      await get().runCheck(file.path, file.name, { kind: 'bytes', fileName: file.name, base64 })
    } catch (err) {
      set({
        documentError: err instanceof Error ? err.message : 'That file could not be read.',
        documentLoading: false
      })
    }
  },

  checkProjectDocument: async (projectFullName, documentId, title) => {
    set({
      documentLoading: true,
      documentError: null,
      documentResult: null,
      documentProgress: null,
      resultForDocId: documentId,
      subjectLabel: title
    })
    try {
      const path = documentId.slice(documentId.indexOf(':') + 1)
      const stored = await readJson<StoredDocument>(projectFullName, path)
      if (!stored) throw new Error('That document could not be read from the project.')
      // Sent as a model, so the main process renders it to a real .docx with exportDocx — the
      // same path an unsaved editor document takes.
      await get().runCheck(documentId, title, {
        kind: 'model',
        fileName: `${title}.docx`,
        model: {
          title: stored.content.title,
          content: stored.content.content,
          pageSetup: stored.content.pageSetup,
          header: stored.content.header,
          footer: stored.content.footer
        }
      })
    } catch (err) {
      set({
        documentError: err instanceof Error ? err.message : 'That document could not be read.',
        documentLoading: false
      })
    }
  },

  runCheck: async (subjectId, label, source) => {
    if (!window.aiper) return
    set({
      documentLoading: true,
      documentError: null,
      documentResult: null,
      documentProgress: null,
      resultForDocId: subjectId,
      subjectLabel: label
    })

    try {
      const result = await window.aiper.compliance.checkDocument(
        subjectId,
        source as never,
        get().selectedModel || undefined
      )
      set({ documentResult: result, documentLoading: false, documentProgress: null })
    } catch (err) {
      // Electron prefixes IPC rejections with the handler name; the readable part is what
      // the provider wrote for a person to act on.
      const raw = err instanceof Error ? err.message : String(err)
      set({
        documentError: raw.replace(/^Error invoking remote method '[^']+':\s*/, ''),
        documentLoading: false,
        documentProgress: null
      })
      // A failed run tells us nothing about the engine's current state; re-check so the panel
      // can distinguish "the engine stopped" from "this document was rejected".
      void get().refreshEngine()
    }
  },

  clearDocumentResult: () =>
    set({
      documentResult: null,
      documentError: null,
      documentProgress: null,
      resultForDocId: null,
      subjectLabel: null
    }),

  applyDocumentProgress: (update) => set({ documentProgress: update }),

  checkFolder: async (folderId, folderPath) => {
    if (!window.aiper) return
    set({ folderRunning: true, folderResult: null })
    const result = await window.aiper.compliance.checkFolder(folderId, folderPath)
    set({ folderResult: result, folderRunning: false })
  },

  applyFolderProgress: (update) => set({ folderRun: update })
}))
