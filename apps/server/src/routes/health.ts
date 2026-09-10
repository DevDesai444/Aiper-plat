import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type pg from 'pg'
import pkg from '../../package.json' with { type: 'json' }

/**
 * Two response shapes so OpenAPI documents both outcomes. Status 200
 * means everything's green; 503 means the DB probe failed. External
 * monitors need the machine-readable difference.
 */
const HealthOkSchema = z.object({
  ok: z.literal(true),
  service: z.literal('aiper-server'),
  version: z.string(),
  db: z.literal('up'),
})

const HealthDownSchema = z.object({
  ok: z.literal(false),
  service: z.literal('aiper-server'),
  version: z.string(),
  db: z.literal('down'),
})

/**
 * Liveness probe with a real DB round-trip. Load balancers and external
 * monitors need this: a server whose process is running but whose pool
 * has gone dead is not actually up.
 *
 * Public — a health check that itself needed auth would defeat the point.
 */
export function registerHealthRoute(app: FastifyInstance, pool: pg.Pool): void {
  app.get(
    '/api/v1/health',
    {
      schema: {
        summary: 'Liveness probe (checks the DB)',
        response: {
          200: HealthOkSchema,
          503: HealthDownSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        await pool.query('SELECT 1')
        return {
          ok: true as const,
          service: 'aiper-server' as const,
          version: pkg.version,
          db: 'up' as const,
        }
      } catch (err) {
        req.log.warn({ err }, 'health check DB probe failed')
        return reply.code(503).send({
          ok: false as const,
          service: 'aiper-server' as const,
          version: pkg.version,
          db: 'down' as const,
        })
      }
    },
  )
}
