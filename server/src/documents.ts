import { createHash } from 'node:crypto'
import { query, queryOne, transaction } from './db.js'
import { writeAudit } from './audit.js'
import type { SessionUser } from './auth.js'

/** A lock is held for this long after the last heartbeat; a crashed client frees it. */
export const LOCK_LEASE_SECONDS = 90

export interface DocumentSummary {
  id: string
  path: string
  title: string
  currentRevision: number
  updatedAt: string | null
  lockedBy: { userId: string; displayName: string; expiresAt: string } | null
}

export function contentHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/**
 * Documents this user can actually reach.
 *
 * Scoped, not global: sign-in is open (anyone with a GitHub account can create a user row), so
 * an unscoped list would hand every new arrival the title and path of every document in the
 * system. A document with no folder is not visible to anyone.
 */
export async function listDocuments(user: SessionUser): Promise<DocumentSummary[]> {
  const rows = await query<{
    id: string
    path: string
    title: string
    current_revision: number
    updated_at: Date | null
    lock_user_id: string | null
    lock_display_name: string | null
    lock_expires_at: Date | null
  }>(
    `SELECT d.id, d.path, d.title, d.current_revision,
            (SELECT max(created_at) FROM document_revisions r WHERE r.document_id = d.id) AS updated_at,
            l.user_id AS lock_user_id, lu.display_name AS lock_display_name, l.expires_at AS lock_expires_at
       FROM documents d
       LEFT JOIN document_locks l ON l.document_id = d.id AND l.expires_at > now()
       LEFT JOIN users lu ON lu.id = l.user_id
      WHERE d.archived_at IS NULL
        AND d.folder_id IS NOT NULL
        AND aiper_effective_access($1, d.folder_id) IS NOT NULL
      ORDER BY d.path`,
    [user.id]
  )
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    currentRevision: r.current_revision,
    updatedAt: r.updated_at?.toISOString() ?? null,
    lockedBy:
      r.lock_user_id && r.lock_expires_at
        ? {
            userId: r.lock_user_id,
            displayName: r.lock_display_name ?? 'Unknown',
            expiresAt: r.lock_expires_at.toISOString()
          }
        : null
  }))
}

export async function createDocument(
  user: SessionUser,
  path: string,
  title: string,
  folderId: string
): Promise<DocumentSummary> {
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const doc = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO documents (path, title, created_by, current_revision, folder_id) VALUES ($1,$2,$3,1,$4) RETURNING id',
      [path, title, user.id, folderId]
    )
    const id = inserted.rows[0].id
    await client.query(
      `INSERT INTO document_revisions
         (document_id, revision, parent_revision, content, content_hash, page_setup, author_id)
       VALUES ($1, 1, NULL, $2, $3, $4, $5)`,
      [
        id,
        JSON.stringify(emptyDoc),
        contentHash(emptyDoc),
        JSON.stringify({
          size: 'A4',
          orientation: 'portrait',
          marginTopMm: 25.4,
          marginBottomMm: 25.4,
          marginLeftMm: 25.4,
          marginRightMm: 25.4,
          columns: 1
        }),
        user.id
      ]
    )
    await writeAudit(
      { userId: user.id, printedName: user.displayName, action: 'document.created', documentId: id, revisionAfter: 1 },
      client
    )
    return id
  })

  const summary = (await listDocuments(user)).find((d) => d.id === doc)
  if (!summary) throw new Error('Document vanished immediately after creation')
  return summary
}

export interface RevisionPayload {
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

export async function getDocument(documentId: string, revision?: number): Promise<RevisionPayload | null> {
  const row = await queryOne<{
    document_id: string
    revision: number
    content: unknown
    page_setup: unknown
    header: unknown
    footer: unknown
    content_hash: string
    display_name: string
    created_at: Date
  }>(
    `SELECT r.document_id, r.revision, r.content, r.page_setup, r.header, r.footer,
            r.content_hash, u.display_name, r.created_at
       FROM document_revisions r JOIN users u ON u.id = r.author_id
      WHERE r.document_id = $1 ${revision ? 'AND r.revision = $2' : ''}
      ORDER BY r.revision DESC LIMIT 1`,
    revision ? [documentId, revision] : [documentId]
  )
  if (!row) return null
  return {
    documentId: row.document_id,
    revision: row.revision,
    content: row.content,
    pageSetup: row.page_setup,
    header: row.header,
    footer: row.footer,
    contentHash: row.content_hash,
    authorName: row.display_name,
    createdAt: row.created_at.toISOString()
  }
}

export type SaveOutcome =
  | { ok: true; revision: number }
  | { ok: false; code: 'locked_by_other'; lockedBy: string }
  | { ok: false; code: 'stale'; currentRevision: number }

/**
 * Append a new revision. Rejects the save when someone else holds the lock, or when the
 * client's base revision is not the current one — silently overwriting another author's work
 * is the failure mode this whole design exists to prevent.
 */
export async function saveRevision(
  user: SessionUser,
  documentId: string,
  baseRevision: number,
  payload: { content: unknown; pageSetup: unknown; header: unknown; footer: unknown },
  reason?: string
): Promise<SaveOutcome> {
  return transaction(async (client) => {
    const doc = await client.query<{ current_revision: number }>(
      'SELECT current_revision FROM documents WHERE id = $1 FOR UPDATE',
      [documentId]
    )
    if (doc.rowCount === 0) throw new Error('No such document')
    const current = doc.rows[0].current_revision

    const lock = await client.query<{ user_id: string; display_name: string }>(
      `SELECT l.user_id, u.display_name FROM document_locks l JOIN users u ON u.id = l.user_id
        WHERE l.document_id = $1 AND l.expires_at > now()`,
      [documentId]
    )
    if (lock.rowCount && lock.rows[0].user_id !== user.id) {
      return { ok: false as const, code: 'locked_by_other' as const, lockedBy: lock.rows[0].display_name }
    }
    if (baseRevision !== current) {
      return { ok: false as const, code: 'stale' as const, currentRevision: current }
    }

    const next = current + 1
    await client.query(
      `INSERT INTO document_revisions
         (document_id, revision, parent_revision, content, content_hash, page_setup, header, footer, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        documentId,
        next,
        current,
        JSON.stringify(payload.content),
        contentHash(payload.content),
        JSON.stringify(payload.pageSetup ?? {}),
        payload.header ? JSON.stringify(payload.header) : null,
        payload.footer ? JSON.stringify(payload.footer) : null,
        user.id
      ]
    )
    await client.query('UPDATE documents SET current_revision = $2 WHERE id = $1', [documentId, next])
    await writeAudit(
      {
        userId: user.id,
        printedName: user.displayName,
        action: 'document.saved',
        documentId,
        revisionBefore: current,
        revisionAfter: next,
        reason: reason ?? null
      },
      client
    )
    return { ok: true as const, revision: next }
  })
}

export interface LockResult {
  ok: boolean
  lockedBy?: string
  expiresAt?: string
}

export async function acquireLock(user: SessionUser, documentId: string): Promise<LockResult> {
  return transaction(async (client) => {
    const existing = await client.query<{ user_id: string; display_name: string }>(
      `SELECT l.user_id, u.display_name FROM document_locks l JOIN users u ON u.id = l.user_id
        WHERE l.document_id = $1 AND l.expires_at > now() FOR UPDATE OF l`,
      [documentId]
    )
    if (existing.rowCount && existing.rows[0].user_id !== user.id) {
      return { ok: false, lockedBy: existing.rows[0].display_name }
    }
    const res = await client.query<{ expires_at: Date }>(
      `INSERT INTO document_locks (document_id, user_id, expires_at)
       VALUES ($1, $2, now() + interval '${LOCK_LEASE_SECONDS} seconds')
       ON CONFLICT (document_id) DO UPDATE
         SET user_id = $2, heartbeat_at = now(), expires_at = now() + interval '${LOCK_LEASE_SECONDS} seconds'
       RETURNING expires_at`,
      [documentId, user.id]
    )
    if (existing.rowCount === 0) {
      await writeAudit(
        { userId: user.id, printedName: user.displayName, action: 'document.checked_out', documentId },
        client
      )
    }
    return { ok: true, expiresAt: res.rows[0].expires_at.toISOString() }
  })
}

export async function releaseLock(user: SessionUser, documentId: string, force = false): Promise<void> {
  const removed = await query<{ user_id: string }>(
    `DELETE FROM document_locks WHERE document_id = $1 ${force ? '' : 'AND user_id = $2'} RETURNING user_id`,
    force ? [documentId] : [documentId, user.id]
  )
  if (removed.length) {
    await writeAudit({
      userId: user.id,
      printedName: user.displayName,
      action: force ? 'document.lock_forced' : 'document.checked_in',
      documentId
    })
  }
}

export async function heartbeatLock(user: SessionUser, documentId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE document_locks
        SET heartbeat_at = now(), expires_at = now() + interval '${LOCK_LEASE_SECONDS} seconds'
      WHERE document_id = $1 AND user_id = $2 RETURNING document_id`,
    [documentId, user.id]
  )
  return rows.length > 0
}

export async function documentHistory(documentId: string): Promise<
  Array<{ revision: number; authorName: string; createdAt: string; contentHash: string }>
> {
  const rows = await query<{ revision: number; display_name: string; created_at: Date; content_hash: string }>(
    `SELECT r.revision, u.display_name, r.created_at, r.content_hash
       FROM document_revisions r JOIN users u ON u.id = r.author_id
      WHERE r.document_id = $1 ORDER BY r.revision DESC`,
    [documentId]
  )
  return rows.map((r) => ({
    revision: r.revision,
    authorName: r.display_name,
    createdAt: r.created_at.toISOString(),
    contentHash: r.content_hash
  }))
}

export interface CommentRow {
  id: string
  markId: string
  quotedText: string
  body: string
  authorName: string
  createdAt: string
  resolvedAt: string | null
}

export async function listComments(documentId: string): Promise<CommentRow[]> {
  const rows = await query<{
    id: string
    mark_id: string
    quoted_text: string
    body: string
    display_name: string
    created_at: Date
    resolved_at: Date | null
  }>(
    `SELECT c.id, c.mark_id, c.quoted_text, c.body, u.display_name, c.created_at, c.resolved_at
       FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.document_id = $1 ORDER BY c.created_at`,
    [documentId]
  )
  return rows.map((r) => ({
    id: r.id,
    markId: r.mark_id,
    quotedText: r.quoted_text,
    body: r.body,
    authorName: r.display_name,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null
  }))
}

export async function addComment(
  user: SessionUser,
  documentId: string,
  markId: string,
  quotedText: string,
  body: string
): Promise<void> {
  await query(
    `INSERT INTO comments (document_id, mark_id, quoted_text, body, author_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (document_id, mark_id) DO NOTHING`,
    [documentId, markId, quotedText, body, user.id]
  )
  await writeAudit({
    userId: user.id,
    printedName: user.displayName,
    action: 'comment.added',
    documentId,
    newValue: { markId, quotedText: quotedText.slice(0, 200) }
  })
}

export async function resolveComment(user: SessionUser, documentId: string, markId: string): Promise<void> {
  await query(
    'UPDATE comments SET resolved_at = now(), resolved_by = $3 WHERE document_id = $1 AND mark_id = $2',
    [documentId, markId, user.id]
  )
  await writeAudit({
    userId: user.id,
    printedName: user.displayName,
    action: 'comment.resolved',
    documentId,
    newValue: { markId }
  })
}

export async function deleteComment(user: SessionUser, documentId: string, markId: string): Promise<void> {
  await query('DELETE FROM comments WHERE document_id = $1 AND mark_id = $2', [documentId, markId])
  await writeAudit({
    userId: user.id,
    printedName: user.displayName,
    action: 'comment.deleted',
    documentId,
    oldValue: { markId }
  })
}
