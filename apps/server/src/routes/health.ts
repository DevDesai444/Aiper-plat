import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }

const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('aiper-server'),
  version: z.string(),
})

/**
 * Liveness probe. Public — a health check that itself needed auth would
 * defeat the point.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get(
    '/api/v1/health',
    {
      schema: {
        summary: 'Server liveness probe',
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({
      ok: true as const,
      service: 'aiper-server' as const,
      version: pkg.version,
    }),
  )
}
