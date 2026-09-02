import { ListTree } from 'lucide-react'
import { useOutlineStore } from '../store/outlineStore'
import { useDocumentStore } from '../store/documentStore'
import { useUiStore } from '../store/uiStore'
import { runEditorCommand } from '../ribbon/editorCommandRegistry'

export default function OutlineTree(): React.JSX.Element {
  const headings = useOutlineStore((s) => s.headings)
  const activeHeadingId = useOutlineStore((s) => s.activeHeadingId)
  const fileName = useDocumentStore((s) => s.fileName)
  const navFilter = useUiStore((s) => s.navFilter).trim().toLowerCase()

  if (!fileName) {
    return (
      <div className="navigator-empty">
        <p>No document open</p>
      </div>
    )
  }

  if (headings.length === 0) {
    return (
      <div className="navigator-empty">
        <p>No headings yet</p>
      </div>
    )
  }

  const visible = navFilter ? headings.filter((h) => h.text.toLowerCase().includes(navFilter)) : headings

  if (visible.length === 0) {
    return (
      <div className="navigator-empty">
        <p>No headings match “{navFilter}”.</p>
      </div>
    )
  }

  return (
    <div className="tree-list">
      {visible.map((h) => (
        <div
          key={h.id}
          className={`tree-row${activeHeadingId === h.id ? ' is-selected' : ''}`}
          style={{ paddingLeft: 9 + (h.level - 1) * 13 }}
          title="Go to this heading"
          // The outline listed headings but ignored clicks, so it read as a control and
          // behaved as a label. Clicking now moves the caret to the heading.
          onClick={() => {
            useOutlineStore.getState().setActiveHeadingId(h.id)
            runEditorCommand('outline.goto', h.pos)
          }}
        >
          <ListTree size={13} strokeWidth={1.5} className="tree-icon" />
          <span className="tree-label">{h.text || 'Untitled heading'}</span>
        </div>
      ))}
    </div>
  )
}
