import { useEffect, useState } from 'react'
import { useDocumentStore } from '../store/documentStore'
import { useComplianceStore } from '../store/complianceStore'
import type { EngineSettings } from '../../../preload/index'

export default function SettingsView(): React.JSX.Element {
  const pageSetup = useDocumentStore((s) => s.pageSetup)

  const engineStatus = useComplianceStore((s) => s.engineStatus)
  const models = useComplianceStore((s) => s.models)
  const selectedModel = useComplianceStore((s) => s.selectedModel)
  const setSelectedModel = useComplianceStore((s) => s.setSelectedModel)
  const refreshEngine = useComplianceStore((s) => s.refreshEngine)

  const [settings, setSettings] = useState<EngineSettings | null>(null)
  const [urlDraft, setUrlDraft] = useState('')

  useEffect(() => {
    if (!window.aiper) return
    void window.aiper.compliance.getEngineSettings().then((loaded) => {
      setSettings(loaded)
      setUrlDraft(loaded.baseUrl)
    })
    void refreshEngine()
  }, [refreshEngine])

  const applyUrl = async (): Promise<void> => {
    if (!window.aiper) return
    const saved = await window.aiper.compliance.setEngineSettings({ baseUrl: urlDraft })
    setSettings((prev) => (prev ? { ...prev, ...saved } : prev))
    await refreshEngine()
  }

  const engineLabel = !engineStatus
    ? 'Checking…'
    : engineStatus.reachable
      ? `Connected · ${engineStatus.environment ?? 'unknown environment'}`
      : `Not reachable — ${engineStatus.error ?? 'no response'}`

  return (
    <div className="settings-view">
      <h2>Settings</h2>
      <div className="settings-group">
        <div className="settings-row">
          <span>Page size</span>
          <span>{pageSetup.size}</span>
        </div>
        <div className="settings-row">
          <span>Platform</span>
          <span>{navigator.platform.includes('Win') ? 'Windows' : 'macOS'}</span>
        </div>
        <div className="settings-row">
          <span>AI provider</span>
          <span>Not connected (stub)</span>
        </div>
      </div>

      <h3 className="settings-heading">Compliance engine</h3>
      <div className="settings-group">
        <div className="settings-row">
          <span>Status</span>
          <span>{engineLabel}</span>
        </div>
        <div className="settings-row">
          <span>Address</span>
          {settings?.urlLocked ? (
            // Set by AIPER_COMPLIANCE_URL. Offering an edit that the environment silently
            // overrides at next launch would be worse than showing it as fixed.
            <span title="Set by the AIPER_COMPLIANCE_URL environment variable">
              {settings.baseUrl} (set by environment)
            </span>
          ) : (
            <span className="settings-inline-edit">
              <input
                type="text"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => void applyUrl()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyUrl()
                }}
                spellCheck={false}
              />
            </span>
          )}
        </div>
        {engineStatus?.reachable && (
          <>
            <div className="settings-row">
              <span>Language model</span>
              <span>{engineStatus.llm ?? 'unknown'}</span>
            </div>
            <div className="settings-row">
              <span>Data store</span>
              <span>{engineStatus.dataStore ?? 'unknown'}</span>
            </div>
          </>
        )}
        <div className="settings-row">
          <span>Detection model</span>
          {models.length > 0 ? (
            <select value={selectedModel} onChange={(e) => void setSelectedModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <span>{engineStatus?.reachable ? 'Engine default' : 'Unavailable'}</span>
          )}
        </div>
      </div>
      <p className="settings-note">
        Single-document checks run against this engine. Folder-level compliance is still example
        data and is labelled as such where it appears.
      </p>
    </div>
  )
}
