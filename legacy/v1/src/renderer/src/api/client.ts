/**
 * Thin HTTP/WebSocket client for the Aiper server. Lives in the renderer rather than the
 * main process because it needs no Node APIs — and keeping it here means the login screen,
 * document list and editor all share one session token without extra IPC hops.
 */

const TOKEN_KEY = 'aiper.session'

export interface ApiUser {
  id: string
  email: string
  displayName: string
  mustChangePassword: boolean
}

export interface ApiDocument {
  id: string
  path: string
  title: string
  currentRevision: number
  updatedAt: string | null
  lockedBy: { userId: string; displayName: string; expiresAt: string } | null
}

export interface ApiRevision {
  documentId: string
  revision: number
  content: unknown
  pageSetup: unknown
  header: unknown
  footer: unknown
  contentHash: string
  authorName: string
  createdAt: string
}

export interface ApiFolderNode {
  id: string
  name: string
  parentId: string | null
  access: 'viewer' | 'editor' | 'owner'
  children: ApiFolderNode[]
  documents: Array<{
    id: string
    path: string
    title: string
    currentRevision: number
    updatedAt: string | null
    lockedBy: { userId: string; displayName: string } | null
  }>
  /**
   * Everything in the project that is not an Aiper document: PDFs, spreadsheets, images, and
   * the original .docx an import kept. Not editable here, but listed — a project imported
   * "whole" that shows only a third of its files has not visibly been imported whole.
   */
  files: Array<{
    path: string
    name: string
    /** Blob sha — how the bytes are fetched, since the contents API caps out at 1 MB. */
    sha: string
    /** `source` marks an original .docx that has an editable projection beside it, so it reads
     *  as the as-imported record rather than a second live copy of the same document. */
    kind: 'source' | 'other'
  }>
}

export interface FolderMember {
  userId: string
  displayName: string
  email: string
  access: 'viewer' | 'editor' | 'owner'
  /** True when the access comes from a parent folder rather than a grant on this one. */
  inherited: boolean
}

export interface PendingInvite {
  email: string
  access: 'viewer' | 'editor' | 'owner'
  invitedAt: string
}

export interface Proposal {
  id: string
  documentId: string
  authorId: string
  authorName: string
  baseRevision: number
  summary: string | null
  status: 'open' | 'accepted' | 'closed'
  createdAt: string
  updatedAt: string
  resolvedByName: string | null
  resultingRevision: number | null
  /** The document has moved on since this was written. */
  stale: boolean
  commentCount: number
}

export interface WordChange {
  kind: 'unchanged' | 'added' | 'removed'
  text: string
}

export interface ProposalReview {
  proposal: Proposal
  diff: {
    blocks: Array<{ status: 'unchanged' | 'added' | 'removed' | 'modified'; blockType: string; words: WordChange[]; text: string }>
    summary: { added: number; removed: number; modified: number; wordsAdded: number; wordsRemoved: number }
  }
  /** Present only when the proposal is stale and no longer applies cleanly. */
  conflicts: Array<{ blockIndex: number; base: string; ours: string; theirs: string }> | null
}

export interface ProposalComment {
  id: string
  authorName: string
  body: string
  createdAt: string
}

export interface AuditEntry {
  id: string
  occurred_at: string
  printed_name: string
  action: string
  document_id: string | null
  revision_before: number | null
  revision_after: number | null
  reason: string | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message)
  }
}

let token: string | null = localStorage.getItem(TOKEN_KEY)

export function getToken(): string | null {
  return token
}

export function setToken(next: string | null): void {
  token = next
  if (next) localStorage.setItem(TOKEN_KEY, next)
  else localStorage.removeItem(TOKEN_KEY)
}


/**
 * The backend.
 *
 * Aiper talks to GitHub, not to a server of its own — see api/githubApi.ts for how projects,
 * folders, documents, proposals and access map onto repositories, files, pull requests and
 * collaborators. The types above are the contract; swapping this line swaps the backend.
 */
export { githubApi as api } from './githubApi'
export { connectEvents, watchDocument, watch } from './events'

export type ServerEvent =
  | { event: 'document:updated'; payload: { documentId: string; revision: number; savedBy: string; savedByUserId: string; savedAt: string } }
  | { event: 'lock:changed'; payload: { documentId: string; lockedBy: string | null; lockedByUserId: string | null } }
  | { event: 'presence:changed'; payload: { userId: string; displayName: string; online: boolean } }
  | { event: 'documents:changed'; payload: { reason: string; documentId: string } }

/** Auto-reconnecting event stream. Returns a disposer. */
