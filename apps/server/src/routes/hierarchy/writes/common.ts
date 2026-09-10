import type { FastifyReply } from 'fastify'
import type pg from 'pg'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'

/** Rank the three roles for threshold checks. viewer < editor < owner. */
const RANK: Record<AiperRole, number> = { viewer: 1, editor: 2, owner: 3 }

export function roleAtLeast(role: AiperRole, min: AiperRole): boolean {
  return RANK[role] >= RANK[min]
}

/** Same shape as the reads' resolveOrDeny, but with an added role-threshold
 *  check. Returns the caller's actual role when it clears the bar; sets a
 *  reply and returns null otherwise. Sequence: 401 → 404 → 403 (insufficient
 *  role or no grant at all). */
export async function resolveOrDenyForWrite(
  pool: pg.Pool,
  reply: FastifyReply,
  userId: string,
  subjectType: AiperSubject,
  subjectId: string,
  minRole: AiperRole,
): Promise<AiperRole | null> {
  const table = SUBJECT_TABLE[subjectType]
  const exists = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [subjectId])
  if (exists.rowCount === 0) {
    void reply.code(404).send({ error: 'Not found', code: 'not_found' })
    return null
  }
  const roleRow = await pool.query<{ role: AiperRole | null }>(
    `SELECT aiper_effective_access($1, $2::aiper_subject, $3) AS role`,
    [userId, subjectType, subjectId],
  )
  const role = roleRow.rows[0]?.role ?? null
  if (role === null || !roleAtLeast(role, minRole)) {
    // Same code for "no grant at all" and "grant too low" — the client
    // shouldn't distinguish so an editor probing for owner-only actions
    // can't discover that they have some access to the subject.
    void reply.code(403).send({ error: 'No access', code: 'no_access' })
    return null
  }
  return role
}

/** Return the caller's display name for audit — populated from JWT, falls back
 *  to email so the audit row is never blank. */
export function printedName(user: { displayName: string; email: string }): string {
  return user.displayName?.trim() || user.email
}

/** 401 shim shared with the read routes' common.ts — kept local to writes/
 *  to avoid a cross-file dependency on the reads directory. */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
}

const SUBJECT_TABLE: Record<AiperSubject, string> = {
  project: 'projects',
  folder: 'folders',
  document: 'documents',
}

/** ISO 8601 UTC string via to_char. Matches the reads' serialisation of
 *  TIMESTAMPTZ columns so returned shapes satisfy z.string().datetime(). */
export const ISO_UTC = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'"
