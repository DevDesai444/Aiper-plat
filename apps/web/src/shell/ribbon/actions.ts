/**
 * Stub ribbon action dispatcher for PR-1b. Every button in the Ribbon calls
 * `runRibbonAction(act)`; for now that just logs so a click through the shell
 * is observable in the dev console. E7 wires editor commands into this
 * dispatcher when the editor lands; E9 wires domain-page commands (e.g.
 * `compat.checkProject`) alongside the compat dashboard.
 *
 * Exposing the surface here rather than inline in the button click handlers
 * keeps the shell components pure JSX + config and gives the eventual
 * routing point exactly one place to live.
 */
export function runRibbonAction(act: string): void {
  // eslint-disable-next-line no-console -- intentional; sole surface for
  // PR-1b's stubbed ribbon buttons.
  console.log('[ribbon]', act)
}
