import * as gh from '../github/client'
import { splitId } from './githubApi'
import type { ServerEvent } from './client'

/**
 * Near-live updates, by polling GitHub.
 *
 * Stated plainly because it is a real limitation rather than an implementation detail: GitHub
 * cannot push to a desktop app. There is no socket to hold open and no webhook a laptop can
 * receive, so someone else's save arrives on the next poll rather than the instant they make
 * it. A few seconds, not zero.
 *
 * What keeps that affordable is conditional requests. Every poll sends the ETag from last time,
 * and GitHub answers 304 Not Modified when nothing has changed — and **304s do not count
 * against the rate limit**. So an idle project costs effectively nothing, and the 5000-per-hour
 * budget is spent on real changes rather than on asking.
 */
const IDLE_MS = 15_000
const ACTIVE_MS = 5_000

interface Watched {
  /** owner/repo of the project currently open, if any. */
  repo: string | null
  documentId: string | null
}

const watched: Watched = { repo: null, documentId: null }

/** Point the poller at what the user is looking at, so the open project refreshes fastest. */
export function watch(opts: { repo?: string | null; documentId?: string | null }): void {
  if (opts.repo !== undefined) watched.repo = opts.repo
  if (opts.documentId !== undefined) watched.documentId = opts.documentId
}

export function watchDocument(documentId: string | null): void {
  watched.documentId = documentId
  watched.repo = documentId ? splitId(documentId).repo : watched.repo
}

/**
 * Poll for changes and report them in the same shape the WebSocket used, so the stores that
 * consume events did not have to change.
 */
export function connectEvents(
  onEvent: (e: ServerEvent) => void,
  onStatus: (online: boolean) => void
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  // Last seen state, so only actual changes are reported rather than every poll.
  let lastCommit: string | null = null
  let lastProposalStamp: string | null = null
  let projectsStamp: string | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    let sawSomething = false

    try {
      // 1. Has the project list changed — a new project, or one shared with you?
      const projects = await gh.listProjects()
      const stamp = projects.map((p) => `${p.fullName}@${p.updatedAt}`).join('|')
      if (projectsStamp !== null && stamp !== projectsStamp) {
        onEvent({ event: 'documents:changed', payload: { reason: 'projects', documentId: '' } })
      }
      projectsStamp = stamp

      // 2. Has the open document moved on, because someone else's change landed?
      if (watched.documentId) {
        const { repo, path } = splitId(watched.documentId)
        const commits = await gh.commitsFor(repo, path)
        const head = commits[0]
        if (head && lastCommit !== null && head.sha !== lastCommit) {
          onEvent({
            event: 'document:updated',
            payload: {
              documentId: watched.documentId,
              revision: commits.length,
              savedBy: head.author,
              savedByUserId: head.author,
              savedAt: head.date
            }
          })
          sawSomething = true
        }
        lastCommit = head?.sha ?? null
      }

      // 3. Have proposals appeared, been commented on, accepted or closed?
      if (watched.repo) {
        const proposals = await gh.listProposals(watched.repo, 'all')
        const stamp2 = proposals.map((p) => `${p.number}:${p.state}:${p.updatedAt}:${p.commentCount}`).join('|')
        if (lastProposalStamp !== null && stamp2 !== lastProposalStamp) {
          onEvent({
            event: 'documents:changed',
            payload: { reason: 'proposals', documentId: watched.documentId ?? '' }
          })
          sawSomething = true
        }
        lastProposalStamp = stamp2
      }

      onStatus(true)
    } catch {
      // Offline, rate-limited, or the token expired. Say so in the status bar and keep trying.
      onStatus(false)
    }

    // Poll faster for a while after something happened — that is when a second change is
    // most likely, and when the user is most likely to be watching for it.
    timer = setTimeout(() => void tick(), sawSomething ? ACTIVE_MS : IDLE_MS)
  }

  void tick()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
