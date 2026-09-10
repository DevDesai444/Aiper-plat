import type { FastifyInstance } from 'fastify'
import { ApiErrorSchema, SessionUserSchema } from '@aiper/shared/schemas'

/**
 * "Who am I?" — the trivial gated route. Every other authenticated route
 * in later PRs uses the same pattern: check req.user, 401 with ApiError
 * if absent, otherwise serve.
 */
export function registerMeRoute(app: FastifyInstance): void {
  app.get(
    '/api/v1/me',
    {
      schema: {
        summary: 'Return the caller identified by the presented JWT',
        response: {
          200: SessionUserSchema,
          401: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
      }
      return req.user
    },
  )
}
