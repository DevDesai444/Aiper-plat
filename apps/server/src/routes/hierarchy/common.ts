import type { FastifyReply } from 'fastify'
import type pg from 'pg'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'

/**
 * Every read route filters by "can the caller reach this subject at all?"
 * A subject that doesn't exist and one the caller has no grant on should
 * look identical from the outside, so the sequence is:
 *
 *   1. 401 no_session  — caller has no verified JWT
 *   2. 404 not_found   — subject row does not exist  (existence-leak guard)
 *   3. 403 no_access   — subject exists, resolver returned null
 *   4. 200             — caller has a role; that role becomes `myRole`
 *
 * The existence check runs before the resolver so 403 is only ever returned
 * for real subjects. Otherwise a client could enumerate every uuid by which
 * status code came back.
 *
 * Reply is set on rejection; the caller returns immediately when this
 * function returns null.
 */
export async function resolveOrDeny(
  pool: pg.Pool,
  reply: FastifyReply,
  userId: string,
  subjectType: AiperSubject,
  subjectId: string,
): Promise<AiperRole | null> {
  // Table name for the existence check. Static lookup — no user input reaches
  // the SQL literal.
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
  if (role === null) {
    void reply.code(403).send({ error: 'No access', code: 'no_access' })
    return null
  }
  return role
}

const SUBJECT_TABLE: Record<AiperSubject, string> = {
  project: 'projects',
  folder: 'folders',
  document: 'documents',
}

/** Shared 401 helper — every gated route calls this at the top. */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
}
