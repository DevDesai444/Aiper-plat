import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { z } from 'zod'
import type { SessionUser } from '@aiper/shared/types'
import type { Config } from '../config.js'

/**
 * The subset of a Supabase-issued JWT payload we care about. Supabase includes
 * a lot more (aud, session_id, role, aal, provider claims, …); we validate
 * only what we lift into a SessionUser.
 */
const JwtPayloadSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  user_metadata: z
    .object({
      name: z.string().optional(),
      full_name: z.string().optional(),
      avatar_url: z.string().url().nullable().optional(),
    })
    .optional(),
})

export type ParsedJwtPayload = z.infer<typeof JwtPayloadSchema>

/**
 * A verifier is opaque to the rest of the server: pass it a raw JWT string,
 * get back the SessionUser, or an error. The two implementations differ only
 * in how they check the signature.
 */
export interface JwtVerifier {
  verify(token: string): Promise<SessionUser>
}

/**
 * Wrap jose's verify result in our shape: the caller doesn't need to know
 * whether we hit a JWKS or an HS256 secret.
 */
async function payloadToSessionUser(payload: JWTPayload): Promise<SessionUser> {
  const parsed = JwtPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`JWT payload is missing required claims: ${parsed.error.message}`)
  }
  const meta = parsed.data.user_metadata
  return {
    id: parsed.data.sub,
    email: parsed.data.email,
    displayName: meta?.name ?? meta?.full_name ?? parsed.data.email,
    avatarUrl: meta?.avatar_url ?? null,
    // PR-3 wires this up against the org_members table. Until then any caller
    // downstream sees an empty membership list, which is safe: no route grants
    // access based on membership alone.
    orgMemberships: [],
  }
}

/**
 * Production verifier: pull keys from Supabase's JWKS endpoint. jose caches
 * the keyset internally with a sensible TTL, so we don't roll our own.
 */
function buildJwksVerifier(url: string): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(url))
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, jwks)
      return payloadToSessionUser(payload)
    },
  }
}

/**
 * Local dev / CI verifier: HS256 with a shared secret. Sufficient to exercise
 * the middleware end-to-end without a live Supabase project.
 */
function buildHmacVerifier(secret: string): JwtVerifier {
  const key = new TextEncoder().encode(secret)
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, key)
      return payloadToSessionUser(payload)
    },
  }
}

/**
 * Pick a verifier based on config. JWKS wins when both are set; that way a
 * misconfigured production deploy that still carries the test secret from a
 * `.env` file does not silently drop back to HS256.
 */
export function buildVerifier(config: Config): JwtVerifier {
  if (config.SUPABASE_JWKS_URL) return buildJwksVerifier(config.SUPABASE_JWKS_URL)
  if (config.SUPABASE_JWT_TEST_SECRET) return buildHmacVerifier(config.SUPABASE_JWT_TEST_SECRET)
  // Should be unreachable — loadConfig() rejects this case at boot.
  throw new Error('buildVerifier called without a JWT verifier configured; loadConfig should have caught this.')
}
