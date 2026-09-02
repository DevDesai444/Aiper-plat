import { Circle } from 'lucide-react'
import { useDocumentStore } from '../store/documentStore'
import { useComplianceStore } from '../store/complianceStore'
import { useEditorStatsStore } from '../store/editorStatsStore'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore, type PageView } from '../store/uiStore'
import { runRibbonAction } from '../ribbon/ribbonActions'

const PAGE_VIEW_LABEL: Record<PageView, string> = {
  print: 'Print layout',
  read: 'Read mode',
  web: 'Web layout',
  draft: 'Draft'
}

export default function StatusBar(): React.JSX.Element {
  const zoom = useDocumentStore((s) => s.zoom)
  const setZoom = useDocumentStore((s) => s.setZoom)
  const language = useDocumentStore((s) => s.language)
  const pageView = useUiStore((s) => s.pageView)
  const trackChangesEnabled = useDocumentStore((s) => s.trackChangesEnabled)
  const documentResult = useComplianceStore((s) => s.documentResult)
  const { wordCount, page, totalPages } = useEditorStatsStore()
  const serverOnline = useSessionStore((s) => s.serverOnline)
  const presence = useSessionStore((s) => s.presence)

  const findingsTotal = documentResult
    ? documentResult.severityCounts.high + documentResult.severityCounts.medium + documentResult.severityCounts.low
    : null

  return (
    <div className="statusbar">
      <span>
        Page {page} of {totalPages}
      </span>
      <span className="statusbar-divider" />
      <span>{wordCount} words</span>
      <span className="statusbar-divider" />
      <button type="button" className="statusbar-btn" onClick={() => void runRibbonAction('review.language')}>
        {language}
      </button>
      <span className="statusbar-divider" />
      <button
        type="button"
        className="statusbar-track statusbar-btn"
        onClick={() => void runRibbonAction('track.toggle')}
        title="Toggle track changes"
      >
        <Circle size={7} fill={trackChangesEnabled ? '#c98b6b' : 'transparent'} stroke="currentColor" strokeWidth={1.5} />
        Track changes {trackChangesEnabled ? 'on' : 'off'}
      </button>
      {findingsTotal !== null && (
        <>
          <span className="statusbar-divider" />
          <button
            type="button"
            className="statusbar-btn"
            onClick={() => useUiStore.getState().setDock('compliance', { open: true })}
            title="Show the compliance findings"
          >
            {findingsTotal} findings
          </button>
        </>
      )}
      <span className="statusbar-divider" />
      <span className="statusbar-track" title={serverOnline ? 'Connected to Aiper server' : 'Not connected'}>
        <Circle
          size={7}
          fill={serverOnline ? '#749dc4' : 'transparent'}
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {serverOnline ? 'Connected' : 'Offline'}
      </span>
      {presence.length > 0 && (
        <>
          <span className="statusbar-divider" />
          <span title={presence.map((p) => p.displayName).join(', ')}>
            {presence.length} other {presence.length === 1 ? 'user' : 'users'} online
          </span>
        </>
      )}
      <span className="statusbar-spacer" />
      <button type="button" className="statusbar-btn" onClick={() => void runRibbonAction('view.printLayout')}>
        {PAGE_VIEW_LABEL[pageView]}
      </button>
      <span className="statusbar-divider" />
      {/* The zoom read-out was drawn as a slider but ignored every click. It now sets the
          zoom from where you click, and the track reflects the real 25–200% range. */}
      <div className="statusbar-zoom">
        <button
          type="button"
          className="statusbar-zoom-step"
          aria-label="Zoom out"
          onClick={() => setZoom(Math.max(25, zoom - 15))}
        >
          −
        </button>
        <div
          className="statusbar-zoom-track"
          role="slider"
          tabIndex={0}
          aria-label="Zoom"
          aria-valuenow={zoom}
          aria-valuemin={25}
          aria-valuemax={200}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const ratio = (e.clientX - rect.left) / rect.width
            setZoom(Math.round((25 + ratio * 175) / 5) * 5)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setZoom(Math.max(25, zoom - 5))
            if (e.key === 'ArrowRight') setZoom(Math.min(200, zoom + 5))
          }}
        >
          <div className="statusbar-zoom-fill" style={{ width: `${((zoom - 25) / 175) * 100}%` }} />
        </div>
        <button
          type="button"
          className="statusbar-zoom-step"
          aria-label="Zoom in"
          onClick={() => setZoom(Math.min(200, zoom + 15))}
        >
          +
        </button>
        <button type="button" className="statusbar-btn" onClick={() => setZoom(100)} title="Reset to 100%">
          {zoom}%
        </button>
      </div>
    </div>
  )
}
