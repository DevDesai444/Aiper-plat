import { useEffect } from 'react'
import BlueprintCard from '../common/BlueprintCard'
import { useComplianceStore } from '../store/complianceStore'
import { useFolderStore } from '../store/folderStore'

function stateLabel(state: string): string {
  switch (state) {
    case 'queued':
      return 'Queued'
    case 'parsing':
      return 'Parsing…'
    case 'detecting':
      return 'Detecting…'
    case 'clear':
      return 'Clear'
    default:
      return ''
  }
}

export default function FolderRun(): React.JSX.Element {
  const selectedFolder = useFolderStore((s) => s.selectedFolder)
  const folderRun = useComplianceStore((s) => s.folderRun)
  const folderResult = useComplianceStore((s) => s.folderResult)
  const folderRunning = useComplianceStore((s) => s.folderRunning)
  const checkFolder = useComplianceStore((s) => s.checkFolder)

  useEffect(() => {
    if (selectedFolder && !folderResult && !folderRunning) {
      checkFolder(selectedFolder.id, selectedFolder.name)
    }
  }, [selectedFolder, folderResult, folderRunning, checkFolder])

  const live = folderResult ?? folderRun
  const rows = live?.rows ?? []
  const documentsComplete = live?.documentsComplete ?? 0
  const documentsTotal = live?.documentsTotal ?? rows.length
  const progressPct = documentsTotal ? Math.round((documentsComplete / documentsTotal) * 100) : 0
  const elapsed = live?.elapsedSeconds ?? 0
  const highTotal = folderResult?.highTotal ?? rows.reduce((sum, r) => sum + r.severityCounts.high, 0)
  const mediumTotal = folderResult?.mediumTotal ?? rows.reduce((sum, r) => sum + r.severityCounts.medium, 0)

  if (!selectedFolder) {
    return (
      <div className="navigator-empty">
        <p>No folder selected.</p>
        <p className="navigator-empty-hint">Click a folder in the left panel, then run the check again.</p>
      </div>
    )
  }

  return (
    <div className="folder-run">
      <div className="folder-run-header">
        <div>
          <div className="folder-run-kicker">Folder compliance run</div>
          <h2>{selectedFolder.name}</h2>
        </div>
        <div className="folder-run-stats">
          <div>
            <span>Documents</span>
            <strong>
              {documentsComplete}/{documentsTotal}
            </strong>
          </div>
          <div>
            <span>High</span>
            <strong className="sev-text--high">{highTotal}</strong>
          </div>
          <div>
            <span>Medium</span>
            <strong className="sev-text--medium">{mediumTotal}</strong>
          </div>
          <div>
            <span>Elapsed</span>
            <strong>{elapsed.toFixed(0)}s</strong>
          </div>
        </div>
      </div>

      <div className="folder-run-progress">
        <div className="folder-run-progress-fill" style={{ right: `${100 - progressPct}%` }} />
        {!folderResult && <div className="folder-run-progress-sweep" />}
      </div>

      <div className="folder-run-columns">
        <div className="folder-run-left">
          <h3>Per-document progress</h3>
          <div className="folder-run-rows">
            {rows.map((row) => {
              const total = row.severityCounts.high + row.severityCounts.medium + row.severityCounts.low
              return (
                <div key={row.docCode} className={`folder-run-row folder-run-row--${row.state}`}>
                  <span className="folder-run-row-dot" />
                  <span className="folder-run-row-code">{row.docCode}</span>
                  <span className="folder-run-row-name">{row.docName}</span>
                  <span className="folder-run-row-state">
                    {row.state === 'findings' ? `${total} findings` : stateLabel(row.state)}
                  </span>
                  <span className="folder-run-row-summary">
                    {total > 0 &&
                      `${row.severityCounts.high}H ${row.severityCounts.medium}M ${row.severityCounts.low}L`}
                  </span>
                </div>
              )
            })}
          </div>

          {folderResult && folderResult.crossDoc.length > 0 && (
            <>
              <h3>Cross-document consistency</h3>
              {folderResult.crossDoc.map((issue) => (
                <BlueprintCard key={issue.id} className="cross-doc-card">
                  <div className="cross-doc-title">{issue.title}</div>
                  <div className="cross-doc-grid">
                    {issue.comparisons.map((c) => (
                      <div key={c.docCode}>
                        <span>{c.docCode}</span>
                        <span>{c.value}</span>
                      </div>
                    ))}
                  </div>
                </BlueprintCard>
              ))}
            </>
          )}
        </div>

        <BlueprintCard className="folder-run-agent-log">
          <div className="folder-run-agent-log-title">Agent activity</div>
          <div className="folder-run-agent-log-lines">
            {(live?.agentLog ?? []).map((line, i, arr) => (
              <div key={i} className="agent-log-line" style={{ opacity: 0.45 + 0.55 * (i / Math.max(arr.length - 1, 1)) }}>
                <span className="agent-log-agent">{line.agent}:</span> {line.message}
              </div>
            ))}
          </div>
        </BlueprintCard>
      </div>
    </div>
  )
}
