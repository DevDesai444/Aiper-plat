import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'

const CONFIG: Config = {
  PORT: 8787,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  SUPABASE_JWT_TEST_SECRET: 'test-secret-plenty-long-enough-for-hs256',
  SUPABASE_JWT_ISSUER: 'https://test-project.supabase.co/auth/v1',
  // Health test builds without a pool, so these values are inert.
  PGHOST: '127.0.0.1',
  PGPORT: 5432,
  PGUSER: 'x',
  PGPASSWORD: 'x',
  PGDATABASE: 'x',
}

test('GET /api/v1/health returns ok + service + version, no auth required', async () => {
  const app = await buildServer(CONFIG)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.service, 'aiper-server')
    assert.equal(typeof body.version, 'string')
    assert.ok(body.version.length > 0)
  } finally {
    await app.close()
  }
})

test('GET /api/v1/openapi.json returns a well-formed OpenAPI spec', async () => {
  const app = await buildServer(CONFIG)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.openapi?.startsWith('3.'), true)
    assert.equal(body.info?.title, 'Aiper Server API')
    // The two documented routes should be present under paths.
    assert.ok(body.paths?.['/api/v1/health'])
    assert.ok(body.paths?.['/api/v1/me'])
  } finally {
    await app.close()
  }
})
