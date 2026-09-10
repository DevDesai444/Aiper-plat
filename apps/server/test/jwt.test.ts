import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT } from 'jose'
import { buildVerifier } from '../src/auth/jwt.js'
import type { Config } from '../src/config.js'

const SECRET = 'test-secret-plenty-long-enough-for-hs256'
const CONFIG: Config = {
  PORT: 8787,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  SUPABASE_JWT_TEST_SECRET: SECRET,
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

test('HS256 verifier round-trips a well-formed Supabase-shaped JWT', async () => {
  const verifier = buildVerifier(CONFIG)
  const token = await signToken({
    sub: '11111111-1111-1111-1111-111111111111',
    email: 'p1@example.com',
    user_metadata: { name: 'P1', avatar_url: 'https://example.com/p1.png' },
  })
  const user = await verifier.verify(token)
  assert.equal(user.id, '11111111-1111-1111-1111-111111111111')
  assert.equal(user.email, 'p1@example.com')
  assert.equal(user.displayName, 'P1')
  assert.equal(user.avatarUrl, 'https://example.com/p1.png')
  assert.deepEqual(user.orgMemberships, [])
})

test('displayName falls back to full_name then to email', async () => {
  const verifier = buildVerifier(CONFIG)

  const tokenFullName = await signToken({
    sub: '22222222-2222-2222-2222-222222222222',
    email: 'p2@example.com',
    user_metadata: { full_name: 'P2 Person' },
  })
  const userFullName = await verifier.verify(tokenFullName)
  assert.equal(userFullName.displayName, 'P2 Person')

  const tokenEmail = await signToken({
    sub: '33333333-3333-3333-3333-333333333333',
    email: 'p3@example.com',
  })
  const userEmail = await verifier.verify(tokenEmail)
  assert.equal(userEmail.displayName, 'p3@example.com')
})

test('a token signed with the wrong secret is rejected', async () => {
  const verifier = buildVerifier(CONFIG)
  const wrong = await new SignJWT({
    sub: '11111111-1111-1111-1111-111111111111',
    email: 'p1@example.com',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('a-completely-different-secret'))

  await assert.rejects(() => verifier.verify(wrong))
})

test('a token missing sub or email is rejected', async () => {
  const verifier = buildVerifier(CONFIG)
  const missingSub = await signToken({ email: 'p1@example.com' })
  await assert.rejects(() => verifier.verify(missingSub))

  const missingEmail = await signToken({
    sub: '11111111-1111-1111-1111-111111111111',
  })
  await assert.rejects(() => verifier.verify(missingEmail))
})
