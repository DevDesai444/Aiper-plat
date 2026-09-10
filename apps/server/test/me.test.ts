import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT } from 'jose'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'

const SECRET = 'test-secret-plenty-long-enough-for-hs256'
const ISSUER = 'https://test-project.supabase.co/auth/v1'
const CONFIG: Config = {
  PORT: 8787,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  SUPABASE_JWT_TEST_SECRET: SECRET,
  SUPABASE_JWT_ISSUER: ISSUER,
  // These me-route tests build buildServer without a pool — the
  // middleware skips provisioning and returns orgMemberships:[].
  PGHOST: '127.0.0.1',
  PGPORT: 5432,
  PGUSER: 'x',
  PGPASSWORD: 'x',
  PGDATABASE: 'x',
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

test('GET /api/v1/me returns 401 + ApiError when no Authorization header', async () => {
  const app = await buildServer(CONFIG)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' })
    assert.equal(res.statusCode, 401)
    const body = res.json()
    assert.equal(typeof body.error, 'string')
    assert.equal(body.code, 'no_session')
  } finally {
    await app.close()
  }
})

test('GET /api/v1/me returns 401 when the token is signed with the wrong secret', async () => {
  const app = await buildServer(CONFIG)
  try {
    // iss + aud correct so the ONLY reason to reject is the wrong signature.
    const bad = await new SignJWT({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'p1@example.com',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-completely-different-secret'))
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${bad}` },
    })
    assert.equal(res.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('GET /api/v1/me returns the SessionUser when a valid JWT is presented', async () => {
  const app = await buildServer(CONFIG)
  try {
    const token = await signToken({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'p1@example.com',
      user_metadata: { name: 'P1', avatar_url: 'https://example.com/p1.png' },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, '11111111-1111-1111-1111-111111111111')
    assert.equal(body.email, 'p1@example.com')
    assert.equal(body.displayName, 'P1')
    assert.equal(body.avatarUrl, 'https://example.com/p1.png')
    assert.deepEqual(body.orgMemberships, [])
  } finally {
    await app.close()
  }
})
