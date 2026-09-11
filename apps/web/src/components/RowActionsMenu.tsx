import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import './rowActions.css'

export interface RowAction {
  /** Menu-item label. */
  label: string
  /** Callback fired when the item is chosen. */
  onSelect: () => void
  /** Renders the item in the "destructive" style; e.g. Delete. */
  danger?: boolean
  /** Force-disable the item (e.g. while a mutation is in flight). */
  disabled?: boolean
}

/**
 * `⋯` button + popover menu. The parent decides which actions to include
 * — pass in only the ones the caller's `myRole` allows and this component
 * renders exactly those. Renders nothing when `actions` is empty, so hosts
 * can pass a filtered list without a wrapping `{... && }` guard.
 *
 * Popover closes on outside click and Escape. Focus / keyboard-arrow
 * navigation between items is deliberately deferred — the menu is short
 * (three items max in this PR), tab-order-only is sufficient for now.
 */
export function RowActionsMenu({
  actions,
  label = 'Row actions',
}: {
  actions: RowAction[]
  /** Accessible label for the trigger button. Set per row for a screen
   *  reader to read a distinct name ("Actions for Mission profile"). */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (actions.length === 0) return null

  return (
    <div className="row-actions" ref={wrapRef}>
      <button
        type="button"
        className="row-actions-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <MoreHorizontal size={14} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="row-actions-menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={a.danger ? 'is-danger' : undefined}
              disabled={a.disabled}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                a.onSelect()
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
