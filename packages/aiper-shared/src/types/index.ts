/**
 * Week-1 interface freeze. These types are the contract between E1's auth /
 * permission code and every other engineer's app. Do not fork them — if a
 * shape needs to change, change it here first and re-publish the package.
 *
 * AuditEntry freezes in week 5 and will land in a follow-up PR.
 */

/**
 * The three access levels every subject uses.
 *   viewer — read
 *   editor — read + write (create/edit content under a folder or document)
 *   owner  — read + write + manage grants on the subject
 */
export type AiperRole = 'viewer' | 'editor' | 'owner'

/** Any resource that can carry access grants. */
export type AiperSubject = 'project' | 'folder' | 'document'

/**
 * The person behind the current request, materialised from a verified
 * Supabase JWT. Attached to req by the auth middleware.
 */
export interface SessionUser {
  /** Supabase auth.uid(); also the row id in the users table. */
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
  /**
   * Orgs this user is a member of at the moment the request was verified.
   * Membership grants no access to projects/folders/documents on its own —
   * an org admin still needs an explicit access_grants row to open content.
   */
  orgMemberships: Array<{ orgId: string; role: 'admin' | 'member' }>
}

/**
 * Highest-role-wins walk from (subjectType, subjectId) up to the root of
 * its chain, collecting every access_grants row for the user. Returns
 * null when no grant exists anywhere in the chain.
 *
 * See PR-3 for the implementation; consumers should call this rather than
 * querying access_grants directly.
 */
export type AccessResolver = (
  userId: string,
  subjectType: AiperSubject,
  subjectId: string,
) => Promise<AiperRole | null>

/**
 * The shape every REST error carries. HTTP status carries the class of
 * failure; `code` narrows it when useful ("stale_revision", "not_owner").
 */
export interface ApiError {
  error: string
  code?: string
}

// Audit chain types (AuditEntry, ChainVerification) — E1 owns; kept in
// their own file so this barrel does not grow linearly.
export * from './audit.js'

// Hierarchy types (Organization, Project, Folder, Document, ProjectFolderTree,
// Comment) — E2 owns; kept in their own file so the two teams don't collide
// on this barrel every week.
export * from './hierarchy.js'

// Blob types (UploadResponse + upload constants) — E2 owns; separate file so
// the wk-5 blob freeze stays independent of the wk-2 hierarchy freeze.
export * from './blobs.js'

// Snapshot types (DocumentSnapshot, SnapshotList, SaveRequest,
// SnapshotReason) — E3 owns; kept in their own file so this barrel does
// not grow linearly.
export * from './snapshots.js'
