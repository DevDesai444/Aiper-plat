import { ChevronLeft, MessageSquareText, ShieldCheck, PenLine, ScrollText, GitPullRequest } from 'lucide-react'
import { useUiStore, type DockTab } from '../store/uiStore'
import AiChatPanel from './AiChatPanel'
import CompliancePanel from './CompliancePanel'
import ReviewPanel from './ReviewPanel'
import AuditPanel from './AuditPanel'
import ProposalsPanel from './ProposalsPanel'

const TABS: Array<{ id: DockTab; label: string; icon: typeof MessageSquareText }> = [
  { id: 'chat', label: 'AI', icon: MessageSquareText },
  { id: 'compliance', label: 'Compliance', icon: ShieldCheck },
  { id: 'proposals', label: 'Changes', icon: GitPullRequest },
  { id: 'comments', label: 'Review', icon: PenLine },
  { id: 'audit', label: 'Audit', icon: ScrollText }
]

export default function Dock(): React.JSX.Element {
  const dockOpen = useUiStore((s) => s.dockOpen)
  const toggleDock = useUiStore((s) => s.toggleDock)
  const dock = useUiStore((s) => s.dock)
  const setDock = useUiStore((s) => s.setDock)

  if (!dockOpen) {
    return (
      <div className="dock dock--collapsed">
        <span className="dock-collapsed-label">AI research</span>
        <button type="button" className="dock-expand-btn" onClick={toggleDock} aria-label="Expand dock">
          <ChevronLeft size={13} strokeWidth={1.5} />
        </button>
      </div>
    )
  }

  return (
    <div className="dock">
      <div className="dock-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={dock === id ? 'is-active' : ''} onClick={() => setDock(id)}>
            <Icon size={13} strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}
        <button type="button" className="dock-collapse-btn" onClick={toggleDock} aria-label="Collapse dock">
          <ChevronLeft size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div className="dock-body">
        {dock === 'chat' && <AiChatPanel />}
        {dock === 'compliance' && <CompliancePanel />}
        {dock === 'comments' && <ReviewPanel />}
        {dock === 'proposals' && <ProposalsPanel />}
        {dock === 'audit' && <AuditPanel />}
      </div>
    </div>
  )
}
