import { contextBridge, ipcRenderer } from 'electron'
import type { AiperDocumentModel, PageSetup } from '../main/services/docx/model'
import type {
  DocumentComplianceResult,
  DocumentRunUpdate,
  EngineStatus,
  FolderRunUpdate,
  ModelRoster
} from '../main/services/compliance/ComplianceProvider'
import type { ComplianceDocumentSource } from '../main/ipc/compliance'
import type { StreamChunk } from '../main/services/ai/AiProvider'
import type { FsTreeNode } from '../main/services/fs/tree'

export interface EngineSettings {
  baseUrl: string
  model: string
  defaultUrl: string
  urlLocked: boolean
}

const aiperApi = {
  platform: process.platform,
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),
  github: {
    isConfigured: (): Promise<boolean> => ipcRenderer.invoke('github:isConfigured'),
    storedToken: (): Promise<string | null> => ipcRenderer.invoke('github:storedToken'),
    signOut: (): Promise<boolean> => ipcRenderer.invoke('github:signOut'),
    startDeviceFlow: (): Promise<{
      deviceCode: string
      userCode: string
      verificationUri: string
      interval: number
      expiresIn: number
    }> => ipcRenderer.invoke('github:startDeviceFlow'),
    pollDeviceFlow: (
      deviceCode: string
    ): Promise<
      | { status: 'pending' }
      | { status: 'slow_down'; interval: number }
      | { status: 'expired' }
      | { status: 'denied' }
      | { status: 'error'; error: string }
      | { status: 'ok'; token: string }
    > => ipcRenderer.invoke('github:pollDeviceFlow', deviceCode)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    setDirty: (dirty: boolean): Promise<void> => ipcRenderer.invoke('window:setDirty', dirty),
    newWindow: (): Promise<boolean> => ipcRenderer.invoke('window:new'),
    arrange: (mode: 'sideBySide' | 'tile'): Promise<boolean> => ipcRenderer.invoke('window:arrange', mode),
    onMaximizeChanged: (cb: (isMaximized: boolean) => void): (() => void) => {
      const listener = (_: unknown, v: boolean): void => cb(v)
      ipcRenderer.on('window:maximizeChanged', listener)
      return (): void => {
        ipcRenderer.removeListener('window:maximizeChanged', listener)
      }
    }
  },
  fs: {
    openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('fs:openFolderDialog'),
    readDirRecursive: (path: string): Promise<FsTreeNode> => ipcRenderer.invoke('fs:readDirRecursive', path),
    saveFileDialog: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('fs:saveFileDialog', defaultName),
    openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('fs:openFileDialog'),
    pickFileForUpload: (): Promise<string | null> => ipcRenderer.invoke('fs:pickFileForUpload'),
    /** File bytes as base64, for a binary-safe upload to GitHub. */
    readFileBase64: (path: string): Promise<string> => ipcRenderer.invoke('fs:readFileBase64', path),
    /** The folder's GitHub origin, or null when it is not already a GitHub repo. */
    gitHubRemote: (path: string): Promise<{ owner: string; repo: string } | null> =>
      ipcRenderer.invoke('fs:gitHubRemote', path)
  },
  docx: {
    read: (path: string) => ipcRenderer.invoke('docx:read', path),
    write: (path: string, model: AiperDocumentModel): Promise<boolean> => ipcRenderer.invoke('docx:write', path, model),
    createBlank: (path: string, model: AiperDocumentModel): Promise<boolean> =>
      ipcRenderer.invoke('docx:createBlank', path, model)
  },
  print: {
    exportPdf: (outPath: string, pageSetup: PageSetup, headerHtml: string, footerHtml: string): Promise<boolean> =>
      ipcRenderer.invoke('print:exportPdf', outPath, pageSetup, headerHtml, footerHtml)
  },
  media: {
    listScreenSources: (): Promise<Array<{ id: string; name: string; thumbnail: string }>> =>
      ipcRenderer.invoke('media:listScreenSources')
  },
  compliance: {
    checkDocument: (
      docId: string,
      source: ComplianceDocumentSource,
      model?: string
    ): Promise<DocumentComplianceResult> =>
      ipcRenderer.invoke('compliance:checkDocument', docId, source, model),
    engineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke('compliance:engineStatus'),
    listModels: (): Promise<ModelRoster> => ipcRenderer.invoke('compliance:listModels'),
    getEngineSettings: (): Promise<EngineSettings> => ipcRenderer.invoke('compliance:getEngineSettings'),
    setEngineSettings: (patch: { baseUrl?: string; model?: string }): Promise<EngineSettings> =>
      ipcRenderer.invoke('compliance:setEngineSettings', patch),
    onDocumentProgress: (cb: (docId: string, update: DocumentRunUpdate) => void): (() => void) => {
      const listener = (_: unknown, docId: string, update: DocumentRunUpdate): void => cb(docId, update)
      ipcRenderer.on('compliance:documentProgress', listener)
      return (): void => {
        ipcRenderer.removeListener('compliance:documentProgress', listener)
      }
    },
    checkFolder: (folderId: string, folderPath: string) => ipcRenderer.invoke('compliance:checkFolder', folderId, folderPath),
    onFolderProgress: (cb: (folderId: string, update: FolderRunUpdate) => void): (() => void) => {
      const listener = (_: unknown, folderId: string, update: FolderRunUpdate): void => cb(folderId, update)
      ipcRenderer.on('compliance:folderProgress', listener)
      return (): void => {
        ipcRenderer.removeListener('compliance:folderProgress', listener)
      }
    }
  },
  ai: {
    sendMessage: (threadId: string, text: string) => ipcRenderer.invoke('ai:sendMessage', threadId, text),
    onMessageChunk: (cb: (threadId: string, chunk: StreamChunk) => void): (() => void) => {
      const listener = (_: unknown, threadId: string, chunk: StreamChunk): void => cb(threadId, chunk)
      ipcRenderer.on('ai:messageChunk', listener)
      return (): void => {
        ipcRenderer.removeListener('ai:messageChunk', listener)
      }
    }
  }
}

export type AiperApi = typeof aiperApi

contextBridge.exposeInMainWorld('aiper', aiperApi)
