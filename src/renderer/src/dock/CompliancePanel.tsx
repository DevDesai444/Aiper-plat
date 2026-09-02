import { useEffect } from 'react'
import { RefreshCw, ShieldAlert, Play } from 'lucide-react'
import { useComplianceStore } from '../store/complianceStore'
import { useDocumentStore } from '../store/documentStore'
import { useUiStore } from '../store/uiStore'
import type {
  DetectionMethod,
  Finding,
  Severity
} from '../../../main/services/compliance/ComplianceProvider'

const SEVERITY_LABEL: Record<Severity, string> = { high: 'high', medium: 'medium', low: 'low' }

/** Spelled out, because the distinction is the point: a recomputed number and a model's
 *  opinion must not read the same to someone deciding whether to act on a finding. */
const METHOD_LABEL: Record<DetectionMethod, string> = {
  'code-verified': 'recomputed',
  checklist: 'checklist',
  'quote-anchored': 'quote-anchored',
  'model-judgment': 'model judgment'
}

function FindingCard({
  finding,
  active,
  onSelect
}: {
  finding: Finding
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <div className={`compliance-finding${active ? ' is-active' : ''}`} onClick={onSelect}>
      <div className="compliance-finding-head">
        <span className={`sev-dot sev-dot--${finding.severity}`} />
        <span className={`compliance-sev-label sev-text--${finding.severity}`}>
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="compliance-tier-pill">{finding.tier}</span>
        {finding.novel && <span className="compliance-tier-pill">novel</span>}
        <span className="compliance-finding-loc">{finding.location}</span>
      </div>
      <div className="compliance-finding-title">{finding.title}</div>
      {finding.detail && <div className="compliance-finding-detail">{finding.detail}</div>}

      {/* The verbatim span the finding rests on. Shown because the first thing a reviewer
          does is check whether the engine actually read what it claims to have read. */}
      {finding.evidence && <blockquote className="compliance-finding-evidence">{finding.evidence}</blockquote>}

      {finding.challengeNote && (
        <div className="compliance-finding-challenge">
          <strong>Counter-evidence:</strong> {finding.challengeNote}
        </div>
      )}

      <div className="compliance-finding-source">
        rule {finding.ruleId} · {METHOD_LABEL[finding.detectionMethod]} ·{' '}
        {finding.precedentCount === 0
          ? 'no precedent'
          : `${finding.precedentCount} precedent${finding.precedentCount === 1 ? '' : 's'}`}
        {typeof finding.confidence === 'number' && ` · ${Math.round(finding.confidence * 100)}% confidence`}
      </div>
    </div>
  )
}

export default function CompliancePanel(): React.JSX.Element {
  const filePath = useDocumentStore((s) => s.filePath)
  const fileName = useDocumentStore((s) => s.fileName)

  const documentResult = useComplianceStore((s) => s.documentResult)
  const documentLoading = useComplianceStore((s) => s.documentLoading)
  const documentProgress = useComplianceStore((s) => s.documentProgress)
  const documentError = useComplianceStore((s) => s.documentError)
  const resultForDocId = useComplianceStore((s) => s.resultForDocId)
  const subjectLabel = useComplianceStore((s) => s.subjectLabel)
  const engineStatus = useComplianceStore((s) => s.engineStatus)
  const checkDocument = useComplianceStore((s) => s.checkDocument)
  const clearDocumentResult = useComplianceStore((s) => s.clearDocumentResult)
  const refreshEngine = useComplianceStore((s) => s.refreshEngine)
  const applyDocumentProgress = useComplianceStore((s) => s.applyDocumentProgress)

  const activeFindingId = useUiStore((s) => s.activeFindingId)
  const setActiveFinding = useUiStore((s) => s.setActiveFinding)

  const docId = filePath ?? fileName ?? ''
  // A check started from the project tree has its own subject, which outlives whatever the
  // editor happens to hold — a PDF is never open in the editor at all.
  const isProjectFile = Boolean(resultForDocId && resultForDocId !== docId)
  const subject = subjectLabel ?? fileName

  useEffect(() => {
    void refreshEngine()
  }, [refreshEngine])

  useEffect(() => {
    if (!window.aiper) return
    return window.aiper.compliance.onDocumentProgress((_docId, update) => applyDocumentProgress(update))
  }, [applyDocumentProgress])

  // Switching documents in the editor invalidates the previous findings — but only when the
  // panel is showing the editor's document. Clearing on a change here would throw away the
  // results of a PDF the reviewer just ran and then clicked away from.
  useEffect(() => {
    if (!useComplianceStore.getState().resultForDocId) return
    if (useComplianceStore.getState().resultForDocId === docId) return
    if (useComplianceStore.getState().subjectLabel === null) clearDocumentResult()
  }, [docId, clearDocumentResult])

  if (!subject) {
    return (
      <div className="navigator-empty">
        <p>Nothing to check</p>
        <p className="navigator-empty-hint">
          Open a document, or use the shield next to any PDF or Word file in the project.
        </p>
      </div>
    )
  }

  if (engineStatus && !engineStatus.reachable) {
    return (
      <div className="compliance-panel">
        <div className="stub-banner">
          <strong>Compliance engine not reachable.</strong> {engineStatus.error}
          <div className="compliance-engine-hint">
            Expected at <code>{engineStatus.baseUrl}</code>. Start it from the deficiency-chatbot
            repo with <code>make api</code>, then retry.
          </div>
        </div>
        <button type="button" className="compliance-action" onClick={() => void refreshEngine()}>
          <RefreshCw size={12} strokeWidth={1.5} /> Retry connection
        </button>
      </div>
    )
  }

  if (documentLoading) {
    return (
      <div className="compliance-panel">
        <div className="compliance-progress">
          <div className="compliance-progress-state">{documentProgress?.message ?? 'Starting analysis'}</div>
          <div className="compliance-progress-meta">
            {documentProgress ? `${documentProgress.elapsedSeconds.toFixed(0)}s elapsed` : 'Contacting the engine…'}
          </div>
          <div className="compliance-progress-bar">
            <div className="compliance-progress-bar-fill" />
          </div>
        </div>
      </div>
    )
  }

  if (documentError) {
    return (
      <div className="compliance-panel">
        <div className="stub-banner">
          <strong>Analysis failed.</strong> {documentError}
        </div>
        {!isProjectFile && (
          <button type="button" className="compliance-action" onClick={() => void checkDocument(docId)}>
            <RefreshCw size={12} strokeWidth={1.5} /> Try again
          </button>
        )}
      </div>
    )
  }

  if (!documentResult) {
    return (
      <div className="compliance-panel">
        <div className="compliance-idle">
          <ShieldAlert size={18} strokeWidth={1.5} />
          <p>Check this document against the deficiency engine.</p>
          <p className="navigator-empty-hint">
            {subject} — the version in the editor is analysed, including unsaved changes.
          </p>
          <button type="button" className="compliance-action" onClick={() => void checkDocument(docId)}>
            <Play size={12} strokeWidth={1.5} /> Run compliance check
          </button>
        </div>
      </div>
    )
  }

  const { severityCounts, findings, analysedInSeconds, engine, modelUsed, domainsChecked } = documentResult
  const total = severityCounts.high + severityCounts.medium + severityCounts.low

  return (
    <div className="compliance-panel">
      {/* Only when the findings really are invented. The rule IDs and severities look
          authoritative either way, so a result that came from the stub has to say so in
          place — a label buried in Settings would not stop someone acting on it. */}
      {engine === 'stub' && (
        <div className="stub-banner">
          <strong>Example data.</strong> No compliance engine is connected — these findings are
          placeholders and must not be used to assess a document.
        </div>
      )}

      <div className="compliance-subject" title={subject}>{subject}</div>
      <div className="compliance-summary">
        <span className="compliance-summary-count">{total}</span>
        <span>{total === 1 ? 'finding in this document' : 'findings in this document'}</span>
      </div>
      <div className="compliance-severity-bar">
        <div style={{ flex: severityCounts.high || 0.0001 }} className="sev-hi" />
        <div style={{ flex: severityCounts.medium || 0.0001 }} className="sev-med" />
        <div style={{ flex: severityCounts.low || 0.0001 }} className="sev-low" />
      </div>
      <div className="compliance-legend">
        {severityCounts.high} high · {severityCounts.medium} medium · {severityCounts.low} low
        <span className="compliance-analysed"> · Analysed in {analysedInSeconds.toFixed(1)}s</span>
      </div>
      {(modelUsed || domainsChecked) && (
        <div className="compliance-run-meta">
          {modelUsed && <>Model {modelUsed}</>}
          {modelUsed && domainsChecked && ' · '}
          {domainsChecked && <>Domains: {domainsChecked.join(', ')}</>}
        </div>
      )}

      {!isProjectFile && (
        <button type="button" className="compliance-action" onClick={() => void checkDocument(docId)}>
          <RefreshCw size={12} strokeWidth={1.5} /> Re-run check
        </button>
      )}

      {total === 0 ? (
        <div className="navigator-empty">
          <p>No findings.</p>
          <p className="navigator-empty-hint">
            The engine found nothing to flag. That is not a clearance — it reflects the domains
            listed above, not every possible deficiency.
          </p>
        </div>
      ) : (
        <div className="compliance-findings">
          {findings.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              active={activeFindingId === f.id}
              onSelect={() => setActiveFinding(f.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
