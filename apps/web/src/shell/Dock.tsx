import {
  ChevronRight,
  MessageSquareText,
  PenLine,
  ScrollText,
  ShieldCheck,
} from 'lucide-react'
import { useUiStore, type DockTabId } from './uiStore'

const TABS: Array<{ id: DockTabId; label: string; icon: typeof MessageSquareText }> = [
  { id: 'chat', label: 'AI', icon: MessageSquareText },
  { id: 'compat', label: 'Compatibility', icon: ShieldCheck },
  { id: 'comments', label: 'Review', icon: PenLine },
  { id: 'audit', label: 'Audit', icon: ScrollText },
]

const PLACEHOLDER: Record<DockTabId, string> = {
  chat: 'AI research panel — E7 wires the chat surface here.',
  compat: 'Compatibility findings feed — E9 populates once /p/:pid/compat is live.',
  comments: 'Document comments — E7 hydrates from GET /api/v1/documents/:did/comments once an editor session is open.',
  audit: 'Audit log — E1 exposes GET /api/v1/audit already; the panel wires up alongside a document view.',
}

/**
 * Right rail. Tab strip is real (data-driven, toggleable), but every panel is
 * a placeholder for PR-1b — the panels themselves belong to the features
 * that own them (E7 for chat + comments, E9 for compat, E1 for audit) and
 * this shell just reserves their slot.
 */
export function Dock() {
  const dockOpen = useUiStore((s) => s.dockOpen)
  const toggleDock = useUiStore((s) => s.toggleDock)
  const dockTab = useUiStore((s) => s.dockTab)
  const setDockTab = useUiStore((s) => s.setDockTab)

  if (!dockOpen) {
    return (
      <aside className="dock dock--collapsed">
        <span className="dock-collapsed-label">Panels</span>
        <button
          type="button"
          className="dock-expand-btn"
          onClick={toggleDock}
          aria-label="Expand dock"
        >
          <ChevronRight size={13} strokeWidth={1.5} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="dock">
      <div className="dock-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={dockTab === id ? 'is-active' : ''}
            onClick={() => setDockTab(id)}
          >
            <Icon size={13} strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}
        <button
          type="button"
          className="dock-collapse-btn"
          onClick={toggleDock}
          aria-label="Collapse dock"
        >
          <ChevronRight
            size={13}
            strokeWidth={1.5}
            style={{ transform: 'rotate(180deg)' }}
          />
        </button>
      </div>
      <div className="dock-body">
        <p className="dock-placeholder">{PLACEHOLDER[dockTab]}</p>
      </div>
    </aside>
  )
}
