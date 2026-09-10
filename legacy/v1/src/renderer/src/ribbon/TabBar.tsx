import { ChevronDown } from 'lucide-react'
import { RIBBON_TAB_ORDER } from './ribbonConfig'
import { useUiStore, type RibbonTabId } from '../store/uiStore'

export default function TabBar(): React.JSX.Element {
  const activeRibbonTab = useUiStore((s) => s.activeRibbonTab)
  const setActiveRibbonTab = useUiStore((s) => s.setActiveRibbonTab)
  const ribbonOpen = useUiStore((s) => s.ribbonOpen)
  const toggleRibbon = useUiStore((s) => s.toggleRibbon)

  return (
    <div className="tabbar">
      <div className="tabbar-tabs">
        {RIBBON_TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tabbar-tab${activeRibbonTab === tab ? ' is-active' : ''}${tab === 'Compliance' ? ' is-compliance' : ''}`}
            onClick={() => setActiveRibbonTab(tab as RibbonTabId)}
          >
            {tab}
          </button>
        ))}
      </div>
      <button type="button" className="tabbar-ribbon-toggle" onClick={toggleRibbon}>
        Ribbon
        <ChevronDown size={12} strokeWidth={1.5} style={{ transform: ribbonOpen ? 'rotate(180deg)' : 'none' }} />
      </button>
    </div>
  )
}
