import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { buildServer } from '../src/server.js'
import { buildPool } from '../src/db.js'
import type { Config } from '../src/config.js'
import { setupTestDb, teardownTestDb, testDbConfig } from './helpers/testdb.js'

let goodPool: pg.Pool
before(async () => {
  goodPool = await setupTestDb()
})
after(async () => {
  await teardownTestDb(goodPool)
})

function buildConfig(): Config {
  const t = testDbConfig()
  return {
    PORT: 0,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SUPABASE_JWT_TEST_SECRET: 'test-secret-plenty-long-enough-for-hs256',
    SUPABASE_JWT_ISSUER: 'https://test-project.supabase.co/auth/v1',
    PGHOST: t.host,
    PGPORT: t.port,
    PGUSER: t.user,
    PGPASSWORD: t.password,
    PGDATABASE: t.database,
  }
}

test('GET /api/v1/health returns 200 with db:up on a healthy pool', async () => {
  const app = await buildServer(buildConfig(), goodPool)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.service, 'aiper-server')
    assert.equal(body.db, 'up')
    assert.equal(typeof body.version, 'string')
  } finally {
    await app.close()
  }
})

test('GET /api/v1/health returns 503 with db:down when the pool cannot connect', async () => {
  // Wire a pool at a port nothing is listening on. connectionTimeoutMillis
  // short so the test does not hang waiting for the OS to give up.
  const badPool = new pg.Pool({
    host: '127.0.0.1',
    port: 1,
    user: 'x',
    password: 'x',
    database: 'x',
    connectionTimeoutMillis: 1000,
  })
  // Swallow the pool-error event so it does not surface as an unhandled
  // event and crash the test process.
  badPool.on('error', () => {})

  const app = await buildServer(buildConfig(), badPool)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    assert.equal(res.statusCode, 503)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.equal(body.db, 'down')
    assert.equal(body.service, 'aiper-server')
  } finally {
    await app.close()
    await badPool.end().catch(() => {})
  }
})
