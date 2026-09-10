# @aiper/server

Fastify 5 backend for the Aiper platform. Verifies Supabase-issued JWTs,
serves the REST API at `/api/v1/*`, and (from PR-3) writes to a
self-hosted PostgreSQL 16.

## Running locally

```bash
cp .env.example .env      # set SUPABASE_JWT_TEST_SECRET at minimum
pnpm --filter @aiper/server dev
```

The server refuses to start unless one of these two env vars is set:

- `SUPABASE_JWKS_URL` — production JWKS endpoint (e.g.
  `https://<project>.supabase.co/auth/v1/keys`). RS256 verification via
  `jose.createRemoteJWKSet`, which caches keys with a built-in TTL.
- `SUPABASE_JWT_TEST_SECRET` — HS256 shared secret for local dev and CI,
  so nothing that runs in a container needs a live Supabase project. Any
  string ≥ 16 characters.

If both are set, `SUPABASE_JWKS_URL` wins. If neither is set, boot fails
with a clear message pointing here.

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
