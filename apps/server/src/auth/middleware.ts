import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { SessionUser } from '@aiper/shared/types'
import type { JwtVerifier } from './jwt.js'
import { provisionAndClaim, fetchOrgMemberships } from './provisioning.js'

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
 * Register a preHandler that tries to verify a JWT on every request.
 * Success attaches SessionUser and adds userId to the request logger
 * context so every subsequent log line names the actor. Failure leaves
 * req.user undefined; routes requiring auth (e.g. /me) reject there.
 *
 * When a pool is passed, three DB-side effects happen inside the same
 * preHandler:
 *   1. INSERT ... ON CONFLICT DO UPDATE the users row — a person invited
 *      by email becomes a real user_id the first time they sign in.
 *   2. UPDATE access_grants to convert any invitations addressed to this
 *      email into user-keyed grants. Same transaction as (1).
 *   3. SELECT org_members to populate SessionUser.orgMemberships. Cached
 *      on req for the request lifetime — downstream handlers reuse it.
 *
 * When no pool is passed (non-DB unit tests), req.user is still attached
 * from the JWT alone with orgMemberships:[]. Public routes stay public
 * whether a token was presented or not.
 */
export function registerAuthMiddleware(
  app: FastifyInstance,
  verifier: JwtVerifier,
  pool?: pg.Pool,
): void {
  app.addHook('preHandler', async (req) => {
    const token = bearer(req)
    if (!token) return
    try {
      const jwtUser = await verifier.verify(token)
      if (pool) {
        await provisionAndClaim(pool, jwtUser)
        const orgMemberships = await fetchOrgMemberships(pool, jwtUser.id)
        req.user = { ...jwtUser, orgMemberships }
      } else {
        req.user = jwtUser
      }
      req.log = req.log.child({ userId: req.user.id })
    } catch (err) {
      // Log at debug level; a failed verification is a client-side
      // problem, not a server error. Routes that require auth still see
      // req.user as undefined and 401 accordingly.
      req.log.debug({ err }, 'JWT verification failed')
    }
  })
}
