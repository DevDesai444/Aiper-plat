import type {
  ComplianceProvider,
  DocumentComplianceResult,
  EngineStatus,
  Finding,
  FolderComplianceResult,
  FolderRunRow,
  ModelRoster,
  AgentLogLine
} from '../ComplianceProvider'

/**
 * Placeholder implementation. The real compliance engine lives in a separate repo
 * (deficiency-chatbot) that isn't ready yet — this returns realistic, deterministic
 * mock data in the exact shape the real backend will eventually return, so the UI is
 * fully wired and demo-ready. Swap `complianceProvider` in ../provider.ts for a real
 * implementation of ComplianceProvider once that backend ships; no UI changes needed.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const MOCK_FINDINGS: Finding[] = [
  {
    id: 'f1',
    severity: 'high',
    tier: 'verified',
    title: 'Assay acceptance criterion inconsistent with 3.2.P.5.1',
    detail: 'This section states 90.0–110.0% while the specification table lists 85.0–115.0% for the same attribute.',
    ruleId: 'CMC-114',
    location: 'p.4 · ¶2',
    detectionMethod: 'code-verified',
    precedentCount: 11
  },
  {
    id: 'f2',
    severity: 'high',
    tier: 'verified',
    title: 'Missing justification for extended shelf-life claim',
    detail: 'A 24-month shelf life is claimed without a corresponding stability data reference in this section.',
    ruleId: 'CMC-201',
    location: 'p.7 · ¶1',
    detectionMethod: 'code-verified',
    precedentCount: 6
  },
  {
    id: 'f3',
    severity: 'medium',
    tier: 'corroborated',
    title: 'Related substances limit stated without method reference',
    detail: 'Consider citing the validated HPLC method (AM-2204) directly adjacent to the numeric limit.',
    ruleId: 'CMC-088',
    location: 'p.5 · ¶3',
    detectionMethod: 'quote-anchored',
    precedentCount: 9
  },
  {
    id: 'f4',
    severity: 'medium',
    tier: 'corroborated',
    title: 'Batch size not explicitly stated for registration batches',
    detail: 'Registration batch table references three batches without stating batch size for each.',
    ruleId: 'CMC-142',
    location: 'p.6 · ¶4',
    detectionMethod: 'quote-anchored',
    precedentCount: 4
  },
  {
    id: 'f5',
    severity: 'medium',
    tier: 'advisory',
    title: 'Table caption style deviates from CTD convention',
    detail: 'Table 3.2.P.5.1-1 caption uses inconsistent capitalization vs. other CTD sections in this submission.',
    ruleId: 'STY-004',
    location: 'p.4 · Table 1',
    detectionMethod: 'model-judgment',
    precedentCount: 2
  },
  {
    id: 'f6',
    severity: 'low',
    tier: 'advisory',
    title: 'Consider adding cross-reference to 3.2.P.8 stability data',
    detail: 'A cross-reference here would help reviewers locate supporting stability evidence.',
    ruleId: 'STY-011',
    location: 'p.5 · ¶1',
    detectionMethod: 'model-judgment',
    precedentCount: 3
  }
]

const FOLDER_DOCS: Array<{ docCode: string; docName: string }> = [
  { docCode: '3.2.P.1', docName: 'Description' },
  { docCode: '3.2.P.2', docName: 'Development' },
  { docCode: '3.2.P.3', docName: 'Manufacture' },
  { docCode: '3.2.P.4', docName: 'Excipients' },
  { docCode: '3.2.P.5', docName: 'Control of Drug Product' },
  { docCode: '3.2.P.6', docName: 'Reference Standards' },
  { docCode: '3.2.P.7', docName: 'Container Closure' },
  { docCode: '3.2.P.8', docName: 'Stability' },
  { docCode: '3.2.S', docName: 'Drug Substance' },
  { docCode: '3.2.A', docName: 'Appendices' },
  { docCode: '3.3', docName: 'Literature' }
]

const AGENTS = ['orchestrator', 'parse', 'router', 'detector.ccs', 'detector.spec', 'oracle', 'challenger', 'consistency', 'vector']

export class StubComplianceProvider implements ComplianceProvider {
  async status(): Promise<EngineStatus> {
    return { reachable: false, baseUrl: '', error: 'No compliance engine is connected.' }
  }

  async listModels(): Promise<ModelRoster> {
    return { models: [], default: '' }
  }

  async checkDocument(docId: string): Promise<DocumentComplianceResult> {
    await sleep(600)
    const findings = MOCK_FINDINGS
    return {
      docId,
      findings,
      severityCounts: {
        high: findings.filter((f) => f.severity === 'high').length,
        medium: findings.filter((f) => f.severity === 'medium').length,
        low: findings.filter((f) => f.severity === 'low').length
      },
      analysedInSeconds: 41.2,
      // Travels with the result so the panel can label it in place. A reviewer must never be
      // shown invented rule IDs and severities without being told what they are.
      engine: 'stub'
    }
  }

  async checkFolder(
    folderId: string,
    _folderPath: string,
    onProgress: (update: import('../ComplianceProvider').FolderRunUpdate) => void
  ): Promise<FolderComplianceResult> {
    const rows: FolderRunRow[] = FOLDER_DOCS.map((d) => ({
      ...d,
      state: 'queued',
      severityCounts: { high: 0, medium: 0, low: 0 }
    }))
    const agentLog: AgentLogLine[] = []
    const start = Date.now()

    const pushLog = (agent: string, message: string): void => {
      agentLog.push({ agent, message, timestamp: new Date().toISOString() })
    }

    pushLog('orchestrator', `folder run started — ${rows.length} documents`)
    onProgress({ rows: [...rows], elapsedSeconds: 0, documentsComplete: 0, documentsTotal: rows.length, agentLog: [...agentLog] })

    for (let i = 0; i < rows.length; i++) {
      rows[i].state = 'parsing'
      pushLog('parse', `${rows[i].docCode} — extracting structure`)
      onProgress({
        rows: [...rows],
        elapsedSeconds: (Date.now() - start) / 1000,
        documentsComplete: i,
        documentsTotal: rows.length,
        agentLog: [...agentLog]
      })
      await sleep(220)

      rows[i].state = 'detecting'
      pushLog(AGENTS[(i + 3) % AGENTS.length], `${rows[i].docCode} — running detectors`)
      onProgress({
        rows: [...rows],
        elapsedSeconds: (Date.now() - start) / 1000,
        documentsComplete: i,
        documentsTotal: rows.length,
        agentLog: [...agentLog]
      })
      await sleep(260)

      const high = i % 4 === 0 ? 1 : 0
      const medium = i % 3 === 0 ? 2 : i % 2
      const low = i % 2
      rows[i].severityCounts = { high, medium, low }
      rows[i].state = high + medium + low === 0 ? 'clear' : 'findings'
      pushLog('oracle', `${rows[i].docCode} — ${high + medium + low || 'no'} finding(s)`)
      onProgress({
        rows: [...rows],
        elapsedSeconds: (Date.now() - start) / 1000,
        documentsComplete: i + 1,
        documentsTotal: rows.length,
        agentLog: [...agentLog]
      })
    }

    pushLog('consistency', 'cross-document pass started')
    await sleep(200)
    pushLog('challenger', 'CMC-088 challenged — limits may be method-specific')
    pushLog('vector', 'precedent index — 41 ANDAs referenced')

    const crossDoc = [
      {
        id: 'x1',
        title: 'Assay acceptance criterion stated three ways',
        comparisons: [
          { docCode: '3.2.P.5', value: '90.0–110.0%' },
          { docCode: '3.2.P.8', value: '90.0–110.0% / 85.0–115.0%' },
          { docCode: '2.3.P', value: '85.0–115.0%' }
        ]
      },
      {
        id: 'x2',
        title: 'Batch numbering inconsistent between manufacture and stability sections',
        comparisons: [
          { docCode: '3.2.P.3', value: 'B-2201, B-2202, B-2203' },
          { docCode: '3.2.P.8', value: 'B-2201, B-2202' }
        ]
      }
    ]

    const highTotal = rows.reduce((sum, r) => sum + r.severityCounts.high, 0)
    const mediumTotal = rows.reduce((sum, r) => sum + r.severityCounts.medium, 0)
    pushLog('orchestrator', `folder run complete — ${folderId}`)

    return {
      rows,
      elapsedSeconds: (Date.now() - start) / 1000,
      documentsComplete: rows.length,
      documentsTotal: rows.length,
      agentLog,
      crossDoc,
      highTotal,
      mediumTotal
    }
  }
}
