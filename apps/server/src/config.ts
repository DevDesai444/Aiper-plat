import { z } from 'zod'

/**
 * Server configuration, validated from process.env at boot. Anything not
 * covered here does NOT enter the running server — reach for a new field
 * on this schema rather than reading process.env from inside a request.
 */
const ConfigInputSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_TEST_SECRET: z.string().min(16).optional(),
  SUPABASE_JWT_ISSUER: z.string().url().optional(),
  // Postgres — required at boot by index.ts. Optional at the schema
  // level so unit tests can build a Config without them and skip the
  // audit route wiring.
  PGHOST: z.string().min(1).optional(),
  PGPORT: z.coerce.number().int().positive().optional(),
  PGUSER: z.string().min(1).optional(),
  PGPASSWORD: z.string().min(1).optional(),
  PGDATABASE: z.string().min(1).optional(),
})

/**
 * Refine cross-field: at least one JWT verifier must be configured, or the
 * server cannot verify a single request and starting up would be a lie.
 */
export const ConfigSchema = ConfigInputSchema.refine(
  (c) => Boolean(c.SUPABASE_JWKS_URL) || Boolean(c.SUPABASE_JWT_TEST_SECRET),
  {
    message:
      'One of SUPABASE_JWKS_URL (production JWKS) or SUPABASE_JWT_TEST_SECRET (HS256 dev fallback) must be set — the server has no way to verify JWTs otherwise. See apps/server/README.md.',
  },
).refine(
  (c) => !(c.SUPABASE_JWKS_URL || c.SUPABASE_JWT_TEST_SECRET) || Boolean(c.SUPABASE_JWT_ISSUER),
  {
    // Without an issuer bound, jwtVerify accepts any well-signed token from
    // the same JWKS — including Supabase's own anon tokens (aud='anon') and
    // tokens from a sibling project sharing the JWKS. Requiring iss + aud is
    // what turns "did anyone sign this?" into "did THIS project's Auth server
    // sign this token for a real end user?".
    message:
      "SUPABASE_JWT_ISSUER must be set (and must equal Supabase's Auth issuer, e.g. https://<ref>.supabase.co/auth/v1) whenever a JWT verifier is configured.",
    path: ['SUPABASE_JWT_ISSUER'],
  },
)

export type Config = z.infer<typeof ConfigSchema>

/**
 * Parse env into a Config; on failure throw a ConfigError with every
 * offending field named. Caller (index.ts) prints and exits — this file
 * stays pure so tests can call loadConfig with a synthesized env.
 */
export class ConfigError extends Error {
  constructor(public readonly issues: readonly z.ZodIssue[]) {
    const lines = issues.map(
      (i) => `  - ${i.path.join('.') || '(config)'}: ${i.message}`,
    )
    super(`Invalid server configuration:\n${lines.join('\n')}`)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(parsed.error.issues)
  return parsed.data
}
