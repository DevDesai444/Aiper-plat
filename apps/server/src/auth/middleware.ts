import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionUser } from '@aiper/shared/types'
import type { JwtVerifier } from './jwt.js'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the auth preHandler when a valid JWT was presented. Undefined
     * when the request was unauthenticated OR the token failed to verify —
     * routes decide which case to treat how.
     */
    user?: SessionUser
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const raw = req.headers.authorization
  if (typeof raw !== 'string') return undefined
  return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : undefined
}

/**
 * Register a preHandler that tries to verify a JWT on every request. Success
 * attaches SessionUser and adds userId to the request logger context so
 * every subsequent log line names the actor. Failure leaves req.user
 * undefined; routes requiring auth (e.g. /me) reject there.
 *
 * Explicitly does NOT reject on absence: that way the same middleware works
 * for public routes (/health, /openapi.json) and gated routes alike.
 */
export function registerAuthMiddleware(app: FastifyInstance, verifier: JwtVerifier): void {
  app.addHook('preHandler', async (req) => {
    const token = bearer(req)
    if (!token) return
    try {
      const user = await verifier.verify(token)
      req.user = user
      req.log = req.log.child({ userId: user.id })
    } catch (err) {
      // Log at debug level; a failed verification is a client-side problem,
      // not a server error. Routes that require auth still see req.user as
      // undefined and 401 accordingly.
      req.log.debug({ err }, 'JWT verification failed')
    }
  })
}
