import { z } from 'zod'
import type {
  AiperSubject,
  AuditPage,
  Comment,
  Document,
  DocumentSnapshot,
  Folder,
  Organization,
  Project,
  ProjectFolderTree,
  SearchResult,
  SessionUser,
} from '@aiper/shared/types'
import {
  AuditPageSchema,
  CommentSchema,
  DocumentSchema,
  DocumentSnapshotSchema,
  FolderSchema,
  OrganizationSchema,
  ProjectFolderTreeSchema,
  ProjectSchema,
  SearchResponseSchema,
  SessionUserSchema,
  SnapshotListSchema,
} from '@aiper/shared/schemas'
import { apiFetch, apiFetchBinary } from './client'

/**
 * Liveness probe. Shape mirrors apps/server/src/routes/health.ts: 200 carries
 * `db: 'up'`; a 503 comes back as an ApiFetchError with `code: 'malformed'`
 * because the down-body is not an ApiError. The Dashboard reads that as
 * "server offline" — the exact code does not matter for the UI.
 */
const HealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal('aiper-server'),
  version: z.string(),
  db: z.literal('up'),
})

export type Health = z.infer<typeof HealthSchema>

/**
 * The wrapper shape hierarchy list routes use — every list endpoint returns
 * `{ items: T[] }`. Constructing the outer schema here (rather than for every
 * caller) keeps the endpoint fns short and their return types clean.
 */
function listSchema<T>(item: z.ZodType<T>): z.ZodType<{ items: T[] }> {
  return z.object({ items: z.array(item) })
}

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return apiFetch('/api/v1/health', { schema: HealthSchema, signal })
}

export function getMe(signal?: AbortSignal): Promise<SessionUser> {
  return apiFetch('/api/v1/me', { schema: SessionUserSchema, signal })
}

// ─── Hierarchy reads ────────────────────────────────────────────────────────

export async function listOrgs(signal?: AbortSignal): Promise<Organization[]> {
  const { items } = await apiFetch('/api/v1/orgs', {
    schema: listSchema(OrganizationSchema),
    signal,
  })
  return items
}

export async function listProjectsInOrg(
  orgId: string,
  signal?: AbortSignal,
): Promise<Project[]> {
  const { items } = await apiFetch(`/api/v1/orgs/${orgId}/projects`, {
    schema: listSchema(ProjectSchema),
    signal,
  })
  return items
}

export function getProject(pid: string, signal?: AbortSignal): Promise<Project> {
  return apiFetch(`/api/v1/projects/${pid}`, { schema: ProjectSchema, signal })
}

export function getProjectFolderTree(
  pid: string,
  signal?: AbortSignal,
): Promise<ProjectFolderTree> {
  return apiFetch(`/api/v1/projects/${pid}/folders`, {
    schema: ProjectFolderTreeSchema,
    signal,
  })
}

export function getFolder(fid: string, signal?: AbortSignal): Promise<Folder> {
  return apiFetch(`/api/v1/folders/${fid}`, { schema: FolderSchema, signal })
}

export async function listFolderDocuments(
  fid: string,
  signal?: AbortSignal,
): Promise<Document[]> {
  const { items } = await apiFetch(`/api/v1/folders/${fid}/documents`, {
    schema: listSchema(DocumentSchema),
    signal,
  })
  return items
}

export function getDocument(did: string, signal?: AbortSignal): Promise<Document> {
  return apiFetch(`/api/v1/documents/${did}`, { schema: DocumentSchema, signal })
}

/**
 * Save-timeline for one document — newest snapshot first. Metadata only:
 * the Yjs bytes for any given snapshot come from `getSnapshotState`. Access
 * is `viewer+` on the server (both non-existence and no-grant collapse to
 * a single 404, so a 404 here means "you cannot see this document").
 */
export async function getDocumentHistory(
  did: string,
  signal?: AbortSignal,
): Promise<DocumentSnapshot[]> {
  const { snapshots } = await apiFetch(`/api/v1/documents/${did}/history`, {
    schema: SnapshotListSchema,
    signal,
  })
  return snapshots
}

/**
 * Fetch the raw Yjs update-stream bytes for one snapshot. Feed the returned
 * `Uint8Array` straight into `Y.applyUpdate(ydoc, bytes)` — the server stores
 * whatever bytes `Y.encodeStateAsUpdate` produced at save time, so no wrapper
 * envelope, no versioning header, no encoding coercion. Access is `viewer+`
 * (server enforces via `requireDocumentRole`).
 */
export function getSnapshotState(
  did: string,
  sid: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return apiFetchBinary(`/api/v1/documents/${did}/snapshots/${sid}/state`, signal)
}

/**
 * Body accepted by `POST /api/v1/documents/:did/save`. Matches the server's
 * `SaveBodySchema` (SaveRequestSchema extended with a required base64
 * `yjsState`). `reason` is free-text — it flows into `audit_log.reason` on
 * the row the server writes alongside the snapshot; the server hardcodes
 * the stored snapshot's `SnapshotReason` to `'checkpoint'` for every POST
 * (auto-saves are the WS server's business), so this field is a "why did
 * you save" audit note, NOT the enum.
 */
export interface SaveBody {
  /** Yjs update stream from `Y.encodeStateAsUpdate`, base64-encoded. */
  yjsState: string
  reason?: string | null
  label?: string | null
}

/**
 * Save a snapshot. Server requires editor+ on the document and rejects
 * bodies over 16 MiB base64. The returned `DocumentSnapshot` carries the
 * server-authoritative `savedAt` — the editor renders that as the "Saved
 * HH:MM" indicator so the clock is the server's, not the client's.
 */
export function postSave(
  did: string,
  body: SaveBody,
  signal?: AbortSignal,
): Promise<DocumentSnapshot> {
  return apiFetch(`/api/v1/documents/${did}/save`, {
    method: 'POST',
    body,
    schema: DocumentSnapshotSchema,
    signal,
  })
}

// ─── Hierarchy writes ───────────────────────────────────────────────────────

/** Kebab-case slug from a display name; matches the server's SlugSchema. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function createProject(orgId: string, name: string): Promise<Project> {
  return apiFetch('/api/v1/projects', {
    method: 'POST',
    body: { orgId, name, slug: slugify(name) },
    schema: ProjectSchema,
  })
}

export function createFolder(
  pid: string,
  name: string,
  parentFolderId?: string | null,
): Promise<Folder> {
  return apiFetch(`/api/v1/projects/${pid}/folders`, {
    method: 'POST',
    body: { name, parentFolderId: parentFolderId ?? null },
    schema: FolderSchema,
  })
}

export function createDocument(fid: string, title: string): Promise<Document> {
  return apiFetch(`/api/v1/folders/${fid}/documents`, {
    method: 'POST',
    body: { title, kind: 'authored' as const },
    schema: DocumentSchema,
  })
}

export function createProjectDocument(pid: string, title: string): Promise<Document> {
  return apiFetch(`/api/v1/projects/${pid}/documents`, {
    method: 'POST',
    body: { title, kind: 'authored' as const },
    schema: DocumentSchema,
  })
}

export async function listProjectDocuments(
  pid: string,
  signal?: AbortSignal,
): Promise<Document[]> {
  const res = await apiFetch(`/api/v1/projects/${pid}/documents`, {
    schema: z.object({ items: z.array(DocumentSchema) }),
    signal,
  })
  return res.items
}

// ─── Document rename / move / archive / delete ─────────────────────────────
//
// Server enforces the role split (routes/hierarchy/writes/documents.ts):
//   rename (title) + archive → editor+
//   move (folderId / projectId, exactly one) → owner
//   delete → owner
// The UI hides actions the caller's myRole can't perform; the server is
// still the authority on any race.

export function renameDocument(did: string, title: string): Promise<Document> {
  return apiFetch(`/api/v1/documents/${did}`, {
    method: 'PATCH',
    body: { title },
    schema: DocumentSchema,
  })
}

/**
 * Move a document to a new parent within the same project. Pass exactly
 * one of `folderId` (into that folder) or `projectId` (to the project
 * root). The server rejects cross-project moves with a 400.
 */
export function moveDocument(
  did: string,
  target: { folderId: string } | { projectId: string },
): Promise<Document> {
  return apiFetch(`/api/v1/documents/${did}`, {
    method: 'PATCH',
    body: target,
    schema: DocumentSchema,
  })
}

export function archiveDocument(
  did: string,
  archivedAt: string | null,
): Promise<Document> {
  return apiFetch(`/api/v1/documents/${did}`, {
    method: 'PATCH',
    body: { archivedAt },
    schema: DocumentSchema,
  })
}

/**
 * Delete a document. Cascades to `document_snapshots` and `comments` on
 * the server (FK cascades on migrations 007 + 008). Owner-only.
 */
export function deleteDocument(did: string): Promise<void> {
  return apiFetch(`/api/v1/documents/${did}`, { method: 'DELETE' })
}

// ─── Folder rename / move / archive / delete ───────────────────────────────

export function renameFolder(fid: string, name: string): Promise<Folder> {
  return apiFetch(`/api/v1/folders/${fid}`, {
    method: 'PATCH',
    body: { name },
    schema: FolderSchema,
  })
}

/**
 * Move a folder within the same project. `parentFolderId: null` means the
 * project root. The server rejects self-parent, cross-project, and cycle-
 * making moves with a 400.
 */
export function moveFolder(
  fid: string,
  parentFolderId: string | null,
): Promise<Folder> {
  return apiFetch(`/api/v1/folders/${fid}`, {
    method: 'PATCH',
    body: { parentFolderId },
    schema: FolderSchema,
  })
}

export function archiveFolder(
  fid: string,
  archivedAt: string | null,
): Promise<Folder> {
  return apiFetch(`/api/v1/folders/${fid}`, {
    method: 'PATCH',
    body: { archivedAt },
    schema: FolderSchema,
  })
}

/**
 * Delete a folder. Cascades to child folders, documents, snapshots, and
 * comments on the server (FK cascades). Owner-only — a folder delete near
 * a project root can remove a lot of rows, so the confirm dialog warns
 * the user before the request goes out.
 */
export function deleteFolder(fid: string): Promise<void> {
  return apiFetch(`/api/v1/folders/${fid}`, { method: 'DELETE' })
}

// ─── Search ───────────────────────────────────────────────────────────────
//
// Backed by E1's search route (routes/search.ts): ILIKE substring on the
// document title, filtered through aiper_effective_access so a caller sees
// only documents they can actually open. Results sort by lower(title) ASC,
// capped at `limit` (default 50, server-capped at 200).

/** Build the query string once — same shape for both search variants. */
function searchParams(q: string, limit?: number): string {
  const params = new URLSearchParams({ q })
  if (limit != null) params.set('limit', String(limit))
  return params.toString()
}

/**
 * Search every document the caller can reach across every project.
 * Returns the parsed `results` array (the outer `{ results: [...] }`
 * envelope is destructured here so callers get a plain array — matches
 * the pattern used by `listOrgs`, `listMembers`, etc.).
 */
export async function searchDocuments(
  q: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const { results } = await apiFetch(`/api/v1/search?${searchParams(q, limit)}`, {
    schema: SearchResponseSchema,
    signal,
  })
  return results
}

/**
 * Same as `searchDocuments`, but narrowed to a single project — used
 * automatically by the global search input when the user is already on
 * a `/p/:pid` route.
 */
export async function searchInProject(
  pid: string,
  q: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const { results } = await apiFetch(
    `/api/v1/projects/${pid}/search?${searchParams(q, limit)}`,
    { schema: SearchResponseSchema, signal },
  )
  return results
}

// ─── Audit / activity ─────────────────────────────────────────────────────

/**
 * Filter set for GET /api/v1/audit. All fields optional; `subjectType` and
 * `subjectId` must be provided together (server enforces — a 400 comes back
 * if only one is set). `before` and `cursor` are alternative page-back
 * mechanisms — server accepts either; the cursor is opaque base64url from
 * a prior page's `nextCursor`.
 */
export interface AuditFilters {
  subjectType?: AiperSubject
  subjectId?: string
  userId?: string
  action?: string
  before?: string
  limit?: number
  cursor?: string
}

function auditParams(filters: AuditFilters): string {
  const params = new URLSearchParams()
  if (filters.subjectType) params.set('subjectType', filters.subjectType)
  if (filters.subjectId) params.set('subjectId', filters.subjectId)
  if (filters.userId) params.set('userId', filters.userId)
  if (filters.action) params.set('action', filters.action)
  if (filters.before) params.set('before', filters.before)
  if (filters.limit != null) params.set('limit', String(filters.limit))
  if (filters.cursor) params.set('cursor', filters.cursor)
  return params.toString()
}

/**
 * One page of audit rows scoped to what the caller can see. The server
 * returns `{ entries, nextCursor }`; nextCursor is null on the last page
 * and an opaque token to pass back for the next page otherwise.
 */
export function getAuditPage(
  filters: AuditFilters,
  signal?: AbortSignal,
): Promise<AuditPage> {
  const qs = auditParams(filters)
  return apiFetch(`/api/v1/audit${qs ? `?${qs}` : ''}`, {
    schema: AuditPageSchema,
    signal,
  })
}

// ─── Comments ──────────────────────────────────────────────────────────────
//
// Comments are anchored to a Yjs mark (`markId`) that lives in the shared
// Y.Doc, so the highlight sync is CRDT-native — but the bodies are here
// over REST. Callers refetch after any mutation to pick up peers' writes;
// the E7 comments panel also refetches on Y.Doc mark-set changes to catch
// remote posts near-live.
//
// Server contract (apps/server/src/routes/hierarchy/{documents,writes/comments}.ts):
//   GET  /api/v1/documents/:did/comments                    → { items: Comment[] }  (viewer+)
//   POST /api/v1/documents/:did/comments                    → Comment (201)          (editor+)
//   POST /api/v1/documents/:did/comments/:markId/resolve    → { comments: Comment[] } (editor+)
//   DELETE /api/v1/documents/:did/comments/:markId          → 204                     (author-or-owner)
//
// Note the two different list envelopes (`items` vs `comments`) — that is
// what the server actually sends, kept as-is per the interface freeze.

/** Body shape accepted by `POST /api/v1/documents/:did/comments`. */
export interface CommentCreate {
  /** Client-generated uuid tying the thread to a Yjs mark. */
  markId: string
  /** Text spanned by the highlight, snapshot at post time (may be ''). */
  quotedText: string
  body: string
}

const CommentListResponse = z.object({ items: z.array(CommentSchema) })
const CommentResolveResponse = z.object({ comments: z.array(CommentSchema) })

/**
 * Oldest-first list of every comment on a document. Server access is
 * `viewer+`; a 404 collapses "no grant" and "does not exist" per the
 * existence-leak guard.
 */
export async function listDocumentComments(
  did: string,
  signal?: AbortSignal,
): Promise<Comment[]> {
  const { items } = await apiFetch(`/api/v1/documents/${did}/comments`, {
    schema: CommentListResponse,
    signal,
  })
  return items
}

/**
 * Create one comment anchored to the given Yjs `markId`. Editor+ on the
 * document. The server denormalises the author's display name from the
 * JWT at write time (see migration 007 header).
 */
export function createComment(did: string, body: CommentCreate): Promise<Comment> {
  return apiFetch(`/api/v1/documents/${did}/comments`, {
    method: 'POST',
    body,
    schema: CommentSchema,
  })
}

/**
 * Resolve every comment anchored to `markId` in one shot. Returns the
 * current rows (with `resolvedAt` + `resolvedBy` set) so the caller can
 * update its list without a second fetch — though the panel does refetch
 * anyway to pick up any interleaving peer writes.
 */
export async function resolveCommentThread(
  did: string,
  markId: string,
): Promise<Comment[]> {
  const { comments } = await apiFetch(
    `/api/v1/documents/${did}/comments/${markId}/resolve`,
    {
      method: 'POST',
      schema: CommentResolveResponse,
    },
  )
  return comments
}

/**
 * Delete every comment anchored to `markId`. Author-or-owner: authors
 * can delete their own thread, doc owners can delete anyone's. An
 * editor who did not author the thread gets 403 (server enforces
 * atomically — no partial delete leaks).
 */
export function deleteCommentThread(did: string, markId: string): Promise<void> {
  return apiFetch(`/api/v1/documents/${did}/comments/${markId}`, {
    method: 'DELETE',
  })
}
