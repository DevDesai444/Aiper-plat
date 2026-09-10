import type pg from 'pg'
import type { AiperSubject } from '@aiper/shared/types'

/**
 * Count the number of user-keyed 'owner' grants on a subject. Used by the
 * last-owner guard on demote / revoke — a subject with zero owners is
 * unreachable and there is no admin path to recover it (see the writeup
 * in legacy/v1/server/src/folders.ts::setFolderAccess for the rationale).
 *
 * Only counts principal_type='user' rows — a pending invite doesn't count
 * as an owner until the invitee signs in and provisionAndClaim converts
 * their row.
 */
export async function countUserOwners(
  pool: pg.Pool | pg.PoolClient,
  subjectType: AiperSubject,
  subjectId: string,
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM access_grants
      WHERE subject_type = $1::aiper_subject
        AND subject_id   = $2
        AND principal_type = 'user'
        AND role         = 'owner'`,
    [subjectType, subjectId],
  )
  return Number(r.rows[0]?.n ?? '0')
}

/**
 * Return true when the incoming permission change would leave the subject
 * with zero owners. `currentTargetRole` is what the target user has right
 * now (null if no grant), `nextRole` is what the caller is asking to set
 * (null for revoke, or the new role for demote / promote / no-op).
 *
 * Guard fires only when the target is currently owner and the change would
 * drop the count below one.
 */
export async function wouldOrphanSubject(
  pool: pg.Pool | pg.PoolClient,
  subjectType: AiperSubject,
  subjectId: string,
  currentTargetRole: 'viewer' | 'editor' | 'owner' | null,
  nextRole: 'viewer' | 'editor' | 'owner' | null,
): Promise<boolean> {
  if (currentTargetRole !== 'owner') return false  // target isn't losing owner
  if (nextRole === 'owner') return false           // still an owner after
  const owners = await countUserOwners(pool, subjectType, subjectId)
  return owners <= 1
}

const SUBJECT_TABLE: Record<AiperSubject, string> = {
  project: 'projects',
  folder: 'folders',
  document: 'documents',
}

/** Existence check for a subject id. Same pattern as reads' resolveOrDeny —
 *  used to distinguish 404 (unknown id) from 403 (no owner grant). */
export async function subjectExists(
  pool: pg.Pool,
  subjectType: AiperSubject,
  subjectId: string,
): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM ${SUBJECT_TABLE[subjectType]} WHERE id = $1`, [subjectId])
  return r.rowCount !== 0
}

/** Normalize an email address for invite lookups. Lowercased + trimmed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
