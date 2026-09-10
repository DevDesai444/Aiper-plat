import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type pg from 'pg'
import {
  ApiErrorSchema,
  AiperSubjectSchema,
  AuditPageSchema,
  ChainVerificationSchema,
} from '@aiper/shared/schemas'
import { readAuditPage, verifyAuditChain } from '../audit.js'

/**
 * Query params for GET /api/v1/audit. All optional. `subjectType` and
 * `subjectId` must be given together — the refine enforces it so a caller
 * cannot ask for "all audit rows for any project" (that would need a
 * different access check we haven't specced).
 */
const AuditListQuerySchema = z
  .object({
    subjectType: AiperSubjectSchema.optional(),
    subjectId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    action: z.string().min(1).max(128).optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(256).optional(),
  })
  .refine((q) => Boolean(q.subjectType) === Boolean(q.subjectId), {
    message: 'subjectType and subjectId must be provided together.',
  })

export function registerAuditRoute(app: FastifyInstance, pool: pg.Pool): void {
  // -------------------------------------------------------------------- verify
  app.get(
    '/api/v1/audit/verify',
    {
      schema: {
        summary: 'Verify the hash chain over audit_log',
        response: {
          200: z.object({ verification: ChainVerificationSchema }),
          401: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
      }
      const verification = await verifyAuditChain(pool)
      return { verification }
    },
  )

  // ------------------------------------------------------------------- list
  app.get(
    '/api/v1/audit',
    {
      schema: {
        summary: 'List audit entries scoped to what the caller can see',
        querystring: AuditListQuerySchema,
        response: {
          200: AuditPageSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
      }
      const q = req.query as z.infer<typeof AuditListQuerySchema>

      // Subject-scoped requests need viewer+ on the subject. Without this
      // gate the resolver-in-WHERE approach used for the general case
      // would just return empty rather than 403 — an explicit access
      // decision is clearer to callers.
      if (q.subjectType && q.subjectId) {
        const r = await pool.query<{ role: string | null }>(
          'SELECT aiper_effective_access($1, $2::aiper_subject, $3) AS role',
          [req.user.id, q.subjectType, q.subjectId],
        )
        if (!r.rows[0]?.role) {
          return reply.code(403).send({
            error: 'No access to this subject.',
            code: 'no_access',
          })
        }
      }

      return await readAuditPage(pool, req.user.id, q)
    },
  )
}
