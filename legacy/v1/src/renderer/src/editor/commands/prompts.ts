/**
 * Prompt helpers shared by the ribbon command modules.
 *
 * These used `window.prompt`, which Electron does not implement — it throws, so every command
 * that asked a question silently did nothing. They now open the in-app dialog and are async;
 * each command that calls one awaits it, which is why the group handlers return promises.
 */
export { pick, askText, askNumber, askLines } from '../../common/promptStore'

/**
 * Parses `Label = value` pairs, one per line, into chart points.
 * Also accepts `Label, value` and `Label: value`.
 */
export function parseDataPairs(raw: string): Array<{ label: string; value: number }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*[=:,]\s*(-?[\d.]+)$/)
      if (!m) return null
      const value = Number(m[2])
      return Number.isFinite(value) ? { label: m[1].trim(), value } : null
    })
    .filter((p): p is { label: string; value: number } => p !== null)
}
