import type { FastifyReply } from 'fastify'
import type pg from 'pg'
import type { AiperRole } from '@aiper/shared/types'

/**
 * Product-tree routes reuse the same 404-existence-hiding gate the
 * save flow and history route already use: non-existent subject and
 * no-grant collapse to one code, so a caller cannot enumerate ids by
 * distinguishing 404 from 403. Same guard PR-3 / PR-5 land, kept in
 * this subtree so a future move-out is a one-file change.
 */

/**
 * Ensure `userId` has at least `viewer` on `projectId`. Returns the
 * role on success; sends a 404 and returns null when the caller
 * lacks any grant on the project OR the project row does not exist —
 * the two collapse to hide project existence from an outsider.
 */
export async function requireProjectViewer(
  pool: pg.Pool,
  reply: FastifyReply,
  userId: string,
  projectId: string,
): Promise<AiperRole | null> {
  const r = await pool.query<{ role: AiperRole | null }>(
    `SELECT aiper_effective_access($1, 'project', $2) AS role`,
    [userId, projectId],
  )
  const role = r.rows[0]?.role ?? null
  if (role === null) {
    void reply.code(404).send({ error: 'Not found', code: 'not_found' })
    return null
  }
  return role
}

/** Same guard, keyed to a document rather than a project. Used by
 *  the reverse doc→nodes lookup so the caller must already have
 *  viewer+ on the document itself before we surface which parts it
 *  describes. */
export async function requireDocumentViewer(
  pool: pg.Pool,
  reply: FastifyReply,
  userId: string,
  documentId: string,
): Promise<AiperRole | null> {
  const r = await pool.query<{ role: AiperRole | null }>(
    `SELECT aiper_effective_access($1, 'document', $2) AS role`,
    [userId, documentId],
  )
  const role = r.rows[0]?.role ?? null
  if (role === null) {
    void reply.code(404).send({ error: 'Not found', code: 'not_found' })
    return null
  }
  return role
}

export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
}

/** Postgres timestamptz → ISO 8601 with a Z suffix — matches
 *  IsoDateTimeSchema (z.string().datetime({ offset: true })). Same
 *  format string every other E3 route uses. */
export const TS_ISO = `to_char({col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
