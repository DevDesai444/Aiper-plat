import { ChevronRight, Plus, PanelLeftClose, Search, ShieldCheck, X } from 'lucide-react'
import { useUiStore } from '../store/uiStore'
import { useFolderStore } from '../store/folderStore'
import { askText } from '../common/promptStore'
import FolderTree from './FolderTree'
import PermissionsDialog from './PermissionsDialog'
import OutlineTree from './OutlineTree'
import { runRibbonAction } from '../ribbon/ribbonActions'

export default function Navigator(): React.JSX.Element {
  const leftOpen = useUiStore((s) => s.leftOpen)
  const toggleLeft = useUiStore((s) => s.toggleLeft)
  const treeTab = useUiStore((s) => s.treeTab)
  const setTreeTab = useUiStore((s) => s.setTreeTab)
  const selectedFolder = useFolderStore((s) => s.selectedFolder)
  const navFilter = useUiStore((s) => s.navFilter)
  const setNavFilter = useUiStore((s) => s.setNavFilter)

  if (!leftOpen) {
    return (
      <div className="navigator navigator--collapsed">
        <button type="button" className="navigator-expand-btn" onClick={toggleLeft} aria-label="Expand navigator">
          <ChevronRight size={13} strokeWidth={1.5} />
        </button>
        <span className="navigator-collapsed-label">Navigator</span>
      </div>
    )
  }

  return (
    <div className="navigator">
      <div className="navigator-header">
        <div className="navigator-tabtoggle">
          <button
            type="button"
            className={treeTab === 'project' ? 'is-active' : ''}
            onClick={() => setTreeTab('project')}
          >
            Project
          </button>
          <button
            type="button"
            className={treeTab === 'outline' ? 'is-active' : ''}
            onClick={() => setTreeTab('outline')}
          >
            Outline
          </button>
        </div>
        <div className="navigator-header-spacer" />
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={async () => {
            const name = await askText('Name your new project', '', {
              hint: 'You will own it, and decide who else gets in.',
              confirmLabel: 'Create'
            })
            if (name?.trim()) await useFolderStore.getState().createFolder(name.trim(), null)
          }}
        >
          <Plus size={13} strokeWidth={1.5} />
        </button>
        <button type="button" aria-label="Collapse navigator" onClick={toggleLeft}>
          <PanelLeftClose size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* This was a static label styled to look like a search field. It now filters the
          tree for real — a control that looks editable has to be editable. */}
      <div className="navigator-filter">
        <Search size={12} strokeWidth={1.5} />
        <input
          type="search"
          value={navFilter}
          placeholder="Filter files and sections"
          onChange={(e) => setNavFilter(e.target.value)}
        />
        {navFilter && (
          <button type="button" aria-label="Clear filter" onClick={() => setNavFilter('')}>
            <X size={11} strokeWidth={1.5} />
          </button>
        )}
      </div>

      <div className="navigator-body">
        {treeTab === 'project' ? <FolderTree /> : <OutlineTree />}
      </div>

      {selectedFolder && (
        <div className="navigator-footer">
          <button type="button" className="navigator-check-folder-btn" onClick={() => runRibbonAction('compliance.checkFolder')}>
            <ShieldCheck size={14} strokeWidth={1.5} />
            Check “{selectedFolder.name}”
          </button>
        </div>
      )}
      <PermissionsDialog />
    </div>
  )
}
