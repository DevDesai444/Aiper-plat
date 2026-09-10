import { ChevronDown } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useUiStore, type RibbonTabId } from './uiStore'
import { RIBBON_TAB_ORDER } from './ribbon/config'

/**
 * Row of ribbon tab buttons. Two behaviours worth calling out:
 *
 *   1. Clicking `Compatibility` while a project is in scope short-cuts to
 *      `/p/:pid/compat` — the dedicated compat dashboard E9 will build. The
 *      tab still activates so the ribbon below shows the Compatibility
 *      commands; the extra navigation just saves a click for the common case
 *      of "I want to see the whole compat picture, not one button". Outside a
 *      project context, the tab just activates.
 *
 *   2. The right-side ribbon-toggle collapses the Ribbon strip below.
 */
export function TabBar() {
  const activeRibbonTab = useUiStore((s) => s.activeRibbonTab)
  const setActiveRibbonTab = useUiStore((s) => s.setActiveRibbonTab)
  const ribbonOpen = useUiStore((s) => s.ribbonOpen)
  const toggleRibbon = useUiStore((s) => s.toggleRibbon)
  const navigate = useNavigate()
  const { pid } = useParams<{ pid?: string }>()

  const onTabClick = (tab: RibbonTabId): void => {
    setActiveRibbonTab(tab)
    if (tab === 'Compatibility' && pid) navigate(`/p/${pid}/compat`)
  }

  return (
    <div className="tabbar">
      <div className="tabbar-tabs">
        {RIBBON_TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tabbar-tab${activeRibbonTab === tab ? ' is-active' : ''}${tab === 'Compatibility' ? ' is-compat' : ''}`}
            onClick={() => onTabClick(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <button type="button" className="tabbar-ribbon-toggle" onClick={toggleRibbon}>
        Ribbon
        <ChevronDown
          size={12}
          strokeWidth={1.5}
          style={{ transform: ribbonOpen ? 'rotate(180deg)' : 'none' }}
        />
      </button>
    </div>
  )
}
