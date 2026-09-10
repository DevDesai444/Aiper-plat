import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type pg from 'pg'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { setupTestDb, teardownTestDb, testDbConfig } from './helpers/testdb.js'

// The health probe itself is exercised in health-db.test.ts (both the
// healthy-pool 200 path and the bad-pool 503 path). This file covers
// the OpenAPI JSON only — it lives here rather than in a separate
// openapi.test.ts because both the openapi spec and the /health route
// share the health.ts source file that documents them.

let db: pg.Pool
before(async () => {
  db = await setupTestDb()
})
after(async () => {
  await teardownTestDb(db)
})

function buildConfig(): Config {
  const t = testDbConfig()
  return {
    PORT: 0,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
  AIPER_ORG_NAME: 'Aiper',
    SUPABASE_JWT_TEST_SECRET: 'test-secret-plenty-long-enough-for-hs256',
    SUPABASE_JWT_ISSUER: 'https://test-project.supabase.co/auth/v1',
    PGHOST: t.host,
    PGPORT: t.port,
    PGUSER: t.user,
    PGPASSWORD: t.password,
    PGDATABASE: t.database,
    SNAPSHOT_AUTO_INTERVAL_MS: 30_000,
  }
}

test('GET /api/v1/openapi.json returns a well-formed OpenAPI 3.x spec', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.openapi?.startsWith('3.'), true)
    assert.equal(body.info?.title, 'Aiper Server API')
    // All the routes we register should be present.
    assert.ok(body.paths?.['/api/v1/health'])
    assert.ok(body.paths?.['/api/v1/me'])
    assert.ok(body.paths?.['/api/v1/audit'])
    assert.ok(body.paths?.['/api/v1/audit/verify'])
  } finally {
    await app.close()
  }
})
