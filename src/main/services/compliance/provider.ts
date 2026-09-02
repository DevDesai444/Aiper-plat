import type {
  ComplianceProvider,
  DocumentComplianceResult,
  DocumentRunUpdate,
  EngineStatus,
  FolderComplianceResult,
  FolderRunUpdate,
  ModelRoster
} from './ComplianceProvider'
import { engineBaseUrl, selectedModel } from './engineConfig'
import { HttpComplianceProvider } from './http/HttpComplianceProvider'
import { StubComplianceProvider } from './stub/StubComplianceProvider'

/**
 * Single swap point, as it always was — but the document check now reaches the real engine.
 *
 * The split is deliberate rather than transitional. Single-document analysis is implemented
 * end to end in the deficiency-chatbot service; folder-level compliance is not, so it stays
 * on the stub and stays labelled as example data in the UI. Routing folder runs to the HTTP
 * provider would only turn a visible placeholder into an error.
 */
const http = new HttpComplianceProvider(engineBaseUrl, selectedModel)
const stub = new StubComplianceProvider()

class RoutedComplianceProvider implements ComplianceProvider {
  status(): Promise<EngineStatus> {
    return http.status()
  }

  listModels(): Promise<ModelRoster> {
    return http.listModels()
  }

  checkDocument(
    docId: string,
    docPath: string,
    options?: { model?: string; onProgress?: (update: DocumentRunUpdate) => void }
  ): Promise<DocumentComplianceResult> {
    return http.checkDocument(docId, docPath, options)
  }

  checkFolder(
    folderId: string,
    folderPath: string,
    onProgress: (update: FolderRunUpdate) => void
  ): Promise<FolderComplianceResult> {
    return stub.checkFolder(folderId, folderPath, onProgress)
  }
}

export const complianceProvider: ComplianceProvider = new RoutedComplianceProvider()
