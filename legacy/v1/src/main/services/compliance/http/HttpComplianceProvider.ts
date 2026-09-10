/**
 * The real compliance engine: the deficiency-chatbot FastAPI service.
 *
 * Analysis is a job, not a request. `POST /api/analyze` accepts the file and returns
 * immediately with a job id; the pipeline then parses, selects domains, fans out to
 * detection sub-agents and runs a challenge pass, which takes tens of seconds. This client
 * polls `GET /api/results/{job_id}` until the job resolves, reporting each status change so
 * the panel can say what is happening rather than spinning.
 *
 * The engine also streams per-agent events over `WS /ws/{job_id}`. That is deliberately not
 * used here: Electron 32 runs Node 20 in the main process, which has no global WebSocket, so
 * consuming it would mean adding a dependency for detail the single-document check does not
 * need. Status polling gives the same four phases the UI shows.
 */
import { readFile } from 'fs/promises'
import { basename } from 'path'
import type {
  ComplianceProvider,
  DocumentComplianceResult,
  DocumentRunUpdate,
  EngineStatus,
  FolderComplianceResult,
  FolderRunUpdate,
  ModelRoster
} from '../ComplianceProvider'
import { mapReport, type WireFaultReport } from './faultMapping'

/** The engine's own job vocabulary, from `databricks.delta.update_job_status`. */
type WireJobStatus = 'accepted' | 'parsing' | 'detecting' | 'complete' | 'error'

interface WireJobResult {
  job_id: string
  status: WireJobStatus
  faults?: WireFaultReport | null
  error?: string | null
}

const POLL_INTERVAL_MS = 1_500
/** A pipeline run is minutes at worst; past this something has gone wrong and the user needs
 *  to be told rather than left watching a spinner. */
const RUN_TIMEOUT_MS = 15 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 4_000

const PHASE_MESSAGE: Record<WireJobStatus, string> = {
  accepted: 'Queued',
  parsing: 'Reading the document',
  detecting: 'Running detection agents',
  complete: 'Complete',
  error: 'Failed'
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Raised when the engine cannot be reached at all, as opposed to refusing the request.
 *  The panel distinguishes the two: one is "start the engine", the other is a real error. */
export class EngineUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly cause: unknown
  ) {
    super(`Compliance engine at ${baseUrl} is not reachable`)
    this.name = 'EngineUnreachableError'
  }
}

export class HttpComplianceProvider implements ComplianceProvider {
  constructor(
    private readonly baseUrl: () => string,
    private readonly defaultModel: () => string
  ) {}

  private async request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const base = this.baseUrl()
    try {
      return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (cause) {
      throw new EngineUnreachableError(base, cause)
    }
  }

  async status(): Promise<EngineStatus> {
    const baseUrl = this.baseUrl()
    try {
      const res = await this.request('/health', {}, HEALTH_TIMEOUT_MS)
      if (!res.ok) {
        return { reachable: false, baseUrl, error: `Engine responded ${res.status}` }
      }
      const body = (await res.json()) as { environment?: string; llm?: string; data_store?: string }
      return {
        reachable: true,
        baseUrl,
        environment: body.environment,
        llm: body.llm,
        dataStore: body.data_store
      }
    } catch {
      return { reachable: false, baseUrl, error: 'No response — is the engine running?' }
    }
  }

  async listModels(): Promise<ModelRoster> {
    try {
      const res = await this.request('/api/models')
      if (!res.ok) return { models: [], default: '' }
      return (await res.json()) as ModelRoster
    } catch {
      // A missing roster is not an error worth surfacing: the engine still has a default.
      return { models: [], default: '' }
    }
  }

  async checkDocument(
    docId: string,
    docPath: string,
    options: { model?: string; onProgress?: (update: DocumentRunUpdate) => void } = {}
  ): Promise<DocumentComplianceResult> {
    const start = Date.now()
    const elapsed = (): number => (Date.now() - start) / 1000
    const report = (state: DocumentRunUpdate['state'], message: string): void =>
      options.onProgress?.({ state, message, elapsedSeconds: elapsed() })

    const model = options.model ?? this.defaultModel()

    report('uploading', 'Sending the document to the engine')
    const jobId = await this.submit(docPath, model)

    let lastStatus: WireJobStatus | null = null
    while (Date.now() - start < RUN_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS)
      const job = await this.fetchJob(jobId)

      if (job.status !== lastStatus) {
        lastStatus = job.status
        report(
          job.status === 'accepted' ? 'queued' : job.status,
          PHASE_MESSAGE[job.status] ?? job.status
        )
      }

      if (job.status === 'error') {
        throw new Error(job.error?.trim() || 'The compliance engine failed while analysing this document.')
      }
      if (job.status === 'complete') {
        if (!job.faults) {
          throw new Error('The engine reported the job complete but returned no findings payload.')
        }
        return mapReport(docId, job.faults, { modelUsed: model || undefined })
      }
    }

    throw new Error(
      `The compliance engine did not finish within ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes.`
    )
  }

  private async submit(docPath: string, model: string): Promise<string> {
    const bytes = await readFile(docPath)
    const form = new FormData()
    // The engine dispatches on the file's leading bytes, but it gates on the extension
    // first, so the name has to survive the upload.
    form.append('file', new Blob([bytes]), basename(docPath))
    if (model) form.append('model', model)

    const res = await this.request('/api/analyze', { method: 'POST', body: form })
    if (!res.ok) {
      // FastAPI puts the reason in `detail`; it is written for a person, so pass it through
      // rather than replacing it with a generic status code.
      const detail = await res
        .json()
        .then((body: { detail?: string }) => body.detail)
        .catch(() => null)
      throw new Error(detail || `The engine refused the document (HTTP ${res.status}).`)
    }
    const body = (await res.json()) as { job_id?: string }
    if (!body.job_id) throw new Error('The engine accepted the document but returned no job id.')
    return body.job_id
  }

  private async fetchJob(jobId: string): Promise<WireJobResult> {
    const res = await this.request(`/api/results/${jobId}`)
    if (res.status === 404) {
      throw new Error(`The engine lost track of job ${jobId}.`)
    }
    if (!res.ok) {
      throw new Error(`The engine returned HTTP ${res.status} while reporting progress.`)
    }
    return (await res.json()) as WireJobResult
  }

  /**
   * Not implemented here. Folder-level compliance is a separate feature still being built in
   * the engine repo, and the caller keeps the stub for it — see `provider.ts`. Throwing
   * rather than silently returning empty keeps the wiring mistake loud if that changes.
   */
  async checkFolder(
    _folderId: string,
    _folderPath: string,
    _onProgress: (update: FolderRunUpdate) => void
  ): Promise<FolderComplianceResult> {
    throw new Error('Folder compliance is not available from the HTTP engine yet.')
  }
}
