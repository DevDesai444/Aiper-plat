import { useUiStore } from './uiStore'
import {
  RIBBON,
  type RibbonBigButton,
  type RibbonSmallButton,
} from './ribbon/config'
import { runRibbonAction } from './ribbon/actions'

/**
 * Data-driven ribbon. Two button shapes:
 *
 *   - BigButton — an icon + label stacked, used for headline commands.
 *   - SmallButton — an icon-only or glyph-only row entry. The glyph variant
 *     styles a single character (B/I/U/S) with the format it applies, so the
 *     Bold button looks bold even before you know what it does.
 *
 * The font-family and font-size selectors are dropdowns instead of buttons —
 * the value they carry has to be visible at rest. Legacy Wired those into
 * the editor's font commands directly; PR-1b logs (via runRibbonAction) so
 * the wiring is observable but harmless until E7 replaces the stub.
 */

function BigButton({ btn }: { btn: RibbonBigButton }) {
  const Icon = btn.icon
  return (
    <button
      type="button"
      className="ribbon-big-btn"
      onClick={() => runRibbonAction(btn.act)}
      title={btn.label}
    >
      <Icon size={20} strokeWidth={1.5} />
      <span>{btn.label}</span>
    </button>
  )
}

const FONT_FAMILIES = ['Times New Roman', 'Arial', 'Calibri', 'Courier New', 'Georgia']
const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32]

function SmallButton({ btn }: { btn: RibbonSmallButton }) {
  const Icon = btn.icon

  if (btn.act === 'font.family') {
    return (
      <select
        className="ribbon-select"
        style={{ width: btn.width }}
        defaultValue={btn.label}
        onChange={(e) => runRibbonAction(`font.setFamily:${e.target.value}`)}
      >
        {FONT_FAMILIES.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    )
  }

  if (btn.act === 'font.size') {
    return (
      <select
        className="ribbon-select ribbon-select--narrow"
        style={{ width: btn.width }}
        defaultValue={btn.label}
        onChange={(e) => runRibbonAction(`font.setSize:${e.target.value}`)}
      >
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    )
  }

  if (btn.glyph) {
    return (
      <button
        type="button"
        className="ribbon-glyph-btn"
        style={{ width: btn.width }}
        data-style={btn.glyphStyle}
        onClick={() => runRibbonAction(btn.act)}
      >
        {btn.glyph}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="ribbon-small-btn"
      style={{ width: btn.width }}
      onClick={() => runRibbonAction(btn.act)}
    >
      {Icon && <Icon size={14} strokeWidth={1.5} />}
      {btn.label && <span>{btn.label}</span>}
    </button>
  )
}

export function Ribbon() {
  const ribbonOpen = useUiStore((s) => s.ribbonOpen)
  const activeRibbonTab = useUiStore((s) => s.activeRibbonTab)

  if (!ribbonOpen) return null

  const groups = RIBBON[activeRibbonTab] ?? []

  return (
    <div className="ribbon">
      {groups.map((group) => (
        <div key={group.name} className="ribbon-group">
          <div className="ribbon-group-content">
            {group.big && (
              <div className="ribbon-group-big">
                {group.big.map((btn) => (
                  <BigButton key={btn.id} btn={btn} />
                ))}
              </div>
            )}
            {group.rows && (
              <div className="ribbon-group-rows">
                {group.rows.map((row, i) => (
                  <div key={i} className="ribbon-row">
                    {row.map((btn) => (
                      <SmallButton key={btn.id} btn={btn} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ribbon-group-label">{group.name}</div>
        </div>
      ))}
    </div>
  )
}
