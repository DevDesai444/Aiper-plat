/**
 * Read the GitHub origin out of a .git/config.
 *
 * This is what decides whether opening a folder adopts an existing project or creates a new
 * repository for it. A spelling this fails to recognise does not error — it silently becomes
 * "not on GitHub", and the user ends up with a duplicate repository holding a second copy of
 * their submission. So it lives on its own, away from anything that needs Electron, and is
 * tested directly.
 */

export interface GitHubRemote {
  owner: string
  repo: string
}

/** `https://github.com/owner/repo(.git)`, with an optional user/token prefix. */
const HTTPS = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i
/** `git@github.com:owner/repo(.git)` and its `ssh://` long form. */
const SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i

export function parseGitHubRemote(config: string): GitHubRemote | null {
  // Only [remote "origin"] counts. A fork's upstream or a mirror is not where this project
  // lives, and adopting one would push someone's submission into a repository they do not own.
  const section = config.split(/^\[/m).find((s) => s.startsWith('remote "origin"'))
  if (!section) return null

  const url = section.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim()
  if (!url) return null

  const match = HTTPS.exec(url) ?? SSH.exec(url)
  return match ? { owner: match[1], repo: match[2] } : null
}
