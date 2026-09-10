import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type pg from 'pg'
import { ApiErrorSchema, ChainVerificationSchema } from '@aiper/shared/schemas'
import { verifyAuditChain } from '../audit.js'

/**
 * Chain verification endpoint. Any authenticated user may trigger — the
 * result reveals only whether the chain is intact and, if not, which
 * row broke, so there is no sensitive content to gate further. Response
 * shape is Zod-typed so it appears in /api/v1/openapi.json.
 */
export function registerAuditRoute(app: FastifyInstance, pool: pg.Pool): void {
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
}
