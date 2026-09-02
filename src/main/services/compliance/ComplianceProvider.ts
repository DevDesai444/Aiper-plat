export type Severity = 'high' | 'medium' | 'low'
export type ConfidenceTier = 'verified' | 'corroborated' | 'advisory'

/** What kind of check stands behind a finding. `checklist` is deterministic like
 *  `code-verified` (a required element was searched for and is absent) but reaching a
 *  different conclusion, and a reviewer deciding how far to trust a finding needs to see
 *  which of the two it was. */
export type DetectionMethod = 'code-verified' | 'checklist' | 'quote-anchored' | 'model-judgment'

export interface Finding {
  id: string
  severity: Severity
  tier: ConfidenceTier
  title: string
  detail: string
  ruleId: string
  location: string
  detectionMethod: DetectionMethod
  precedentCount: number

  /** Everything below is supplied by the real engine and absent from the stub. */
  /** The verbatim span the finding rests on — the thing a reviewer checks first. */
  evidence?: string
  category?: string
  confidence?: number
  /** What produced it, e.g. `oracle:result_vs_limit`, `specialist:impurities`. */
  source?: string
  guidanceRefs?: string[]
  /** Counter-evidence the challenge pass found, when it lowered confidence. */
  challengeNote?: string
  /** No matching precedent in the knowledge base. */
  novel?: boolean
  section?: string
  page?: number
}

/** Which implementation produced a result. The UI must not present invented findings as
 *  analysis, so this travels with the result rather than being inferred from settings. */
export type ComplianceEngineKind = 'stub' | 'http'

export interface DocumentComplianceResult {
  docId: string
  findings: Finding[]
  severityCounts: Record<Severity, number>
  analysedInSeconds: number
  engine: ComplianceEngineKind
  /** The detection model the engine actually ran, when it reports one. */
  modelUsed?: string
  /** Domains the selector chose to review — useful for judging coverage. */
  domainsChecked?: string[]
}

export type DocumentRunState = 'uploading' | 'queued' | 'parsing' | 'detecting' | 'complete' | 'error'

export interface DocumentRunUpdate {
  state: DocumentRunState
  message: string
  elapsedSeconds: number
}

export interface EngineStatus {
  reachable: boolean
  baseUrl: string
  /** Present only when reachable. */
  environment?: string
  llm?: string
  dataStore?: string
  /** Why it is not reachable, in terms a user can act on. */
  error?: string
}

export interface ModelOption {
  id: string
  label: string
}

export interface ModelRoster {
  models: ModelOption[]
  default: string
}

export type RunRowState = 'queued' | 'parsing' | 'detecting' | 'clear' | 'findings' | 'error'

export interface FolderRunRow {
  docCode: string
  docName: string
  state: RunRowState
  severityCounts: Record<Severity, number>
}

export interface CrossDocIssue {
  id: string
  title: string
  comparisons: Array<{ docCode: string; value: string }>
}

export interface AgentLogLine {
  agent: string
  message: string
  timestamp: string
}

export interface FolderRunUpdate {
  rows: FolderRunRow[]
  elapsedSeconds: number
  documentsComplete: number
  documentsTotal: number
  agentLog: AgentLogLine[]
}

export interface FolderComplianceResult extends FolderRunUpdate {
  crossDoc: CrossDocIssue[]
  highTotal: number
  mediumTotal: number
}

export interface ComplianceProvider {
  checkDocument(
    docId: string,
    docPath: string,
    options?: {
      /** Detection model to request; the engine falls back to its default if unknown. */
      model?: string
      onProgress?: (update: DocumentRunUpdate) => void
    }
  ): Promise<DocumentComplianceResult>
  checkFolder(
    folderId: string,
    folderPath: string,
    onProgress: (update: FolderRunUpdate) => void
  ): Promise<FolderComplianceResult>
  /** Whether the engine can be reached, for the panel to show before a run is attempted. */
  status(): Promise<EngineStatus>
  listModels(): Promise<ModelRoster>
}
