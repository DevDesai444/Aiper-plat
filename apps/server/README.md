# @aiper/server

Fastify 5 backend for the Aiper platform. Verifies Supabase-issued JWTs,
serves the REST API at `/api/v1/*`, and (from PR-3) writes to a
self-hosted PostgreSQL 16.

## Running locally

```bash
cp .env.example .env      # set SUPABASE_JWT_TEST_SECRET at minimum
pnpm --filter @aiper/server dev
```

The server refuses to start unless BOTH of the following are true:

1. **`SUPABASE_JWT_ISSUER` is set** (always required). This is your
   project's Auth issuer, e.g.
   `https://<project-ref>.supabase.co/auth/v1`. Every JWT is checked
   against this exact issuer AND against `aud='authenticated'` — a token
   from a sibling project (different `iss`) or a Supabase anon token
   (`aud='anon'`) will not sign anyone in.
2. **One of the two verifiers is configured:**
   - `SUPABASE_JWKS_URL` — production JWKS endpoint (e.g.
     `https://<project-ref>.supabase.co/auth/v1/keys`). RS256/ES256 via
     `jose.createRemoteJWKSet`, keys cached with a built-in TTL.
   - `SUPABASE_JWT_TEST_SECRET` — HS256 shared secret for local dev and
     CI, so nothing that runs in a container needs a live Supabase
     project. Any string ≥ 16 characters. **Do not use in production.**

If both `SUPABASE_JWKS_URL` and `SUPABASE_JWT_TEST_SECRET` are set,
`SUPABASE_JWKS_URL` wins — a leftover test secret in a `.env` cannot
silently weaken a real deploy. If a verifier is set without
`SUPABASE_JWT_ISSUER`, or if neither verifier is set, boot fails with a
clear per-field message.

## Routes (PR-2)

- `GET /api/v1/health` — public. Returns
  `{ ok: true, service: "aiper-server", version: <pkg.version> }`.
- `GET /api/v1/openapi.json` — public. Auto-generated OpenAPI 3 spec from
  the Zod route schemas via `fastify-type-provider-zod` + `@fastify/swagger`.
- `GET /api/v1/me` — requires a valid JWT in `Authorization: Bearer …`.
  Returns the `SessionUser` extracted from the token; 401 + `ApiError`
  when no JWT is present or verification fails.

More routes land in later PRs. See the E1 briefing.

## Testing

```bash
pnpm --filter @aiper/server test
```

Uses `node --test` via `tsx`. Every route test runs through Fastify's
`app.inject(...)`, so nothing binds to a real port. JWKS mode is not
exercised in unit tests (a live Supabase would be required); HS256 mode
covers the middleware wiring end to end and is what the CI job runs.
