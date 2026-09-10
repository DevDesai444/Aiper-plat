import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from '../src/config.js'

const BASE_ENV: NodeJS.ProcessEnv = {
  PORT: '8787',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  AIPER_ORG_NAME: 'Aiper',
  // Postgres credentials must be present for loadConfig to succeed at all.
  PGUSER: 'aiper',
  PGPASSWORD: 'aiper_dev',
  PGDATABASE: 'aiper',
}

const ISSUER = 'https://example.supabase.co/auth/v1'

test('loadConfig accepts JWKS URL + issuer + DB config', () => {
  const config = loadConfig({
    ...BASE_ENV,
    SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/keys',
    SUPABASE_JWT_ISSUER: ISSUER,
  })
  assert.equal(config.SUPABASE_JWKS_URL, 'https://example.supabase.co/auth/v1/keys')
  assert.equal(config.SUPABASE_JWT_ISSUER, ISSUER)
  assert.equal(config.PORT, 8787)
  // PGHOST and PGPORT fall through to defaults when unset.
  assert.equal(config.PGHOST, '127.0.0.1')
  assert.equal(config.PGPORT, 5432)
})

test('loadConfig accepts HS256 test secret + issuer + DB config', () => {
  const config = loadConfig({
    ...BASE_ENV,
    SUPABASE_JWT_TEST_SECRET: 'this-is-a-long-enough-test-secret',
    SUPABASE_JWT_ISSUER: ISSUER,
  })
  assert.equal(config.SUPABASE_JWT_TEST_SECRET, 'this-is-a-long-enough-test-secret')
})

test('loadConfig refuses to boot when neither JWKS URL nor test secret is set', () => {
  assert.throws(
    () => loadConfig(BASE_ENV),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /SUPABASE_JWKS_URL/)
      assert.match(err.message, /SUPABASE_JWT_TEST_SECRET/)
      return true
    },
  )
})

test('loadConfig refuses when a verifier is set but SUPABASE_JWT_ISSUER is missing', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        SUPABASE_JWT_TEST_SECRET: 'this-is-a-long-enough-test-secret',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /SUPABASE_JWT_ISSUER/)
      return true
    },
  )
})

test('loadConfig refuses malformed values with a clear per-field message', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        SUPABASE_JWT_TEST_SECRET: 'too-short',
        SUPABASE_JWT_ISSUER: ISSUER,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /SUPABASE_JWT_TEST_SECRET/)
      return true
    },
  )
})

test('loadConfig refuses when PGUSER / PGPASSWORD / PGDATABASE is missing', () => {
  // Drop PGUSER — should fail with a message naming that field.
  const { PGUSER, ...noUser } = BASE_ENV
  void PGUSER
  assert.throws(
    () =>
      loadConfig({
        ...noUser,
        SUPABASE_JWT_TEST_SECRET: 'this-is-a-long-enough-test-secret',
        SUPABASE_JWT_ISSUER: ISSUER,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /PGUSER/)
      return true
    },
  )
})
