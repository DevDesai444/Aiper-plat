import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from '../src/config.js'

const BASE_ENV: NodeJS.ProcessEnv = {
  PORT: '8787',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
}

test('loadConfig accepts JWKS URL alone', () => {
  const config = loadConfig({
    ...BASE_ENV,
    SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/keys',
  })
  assert.equal(config.SUPABASE_JWKS_URL, 'https://example.supabase.co/auth/v1/keys')
  assert.equal(config.PORT, 8787)
})

test('loadConfig accepts HS256 test secret alone', () => {
  const config = loadConfig({
    ...BASE_ENV,
    SUPABASE_JWT_TEST_SECRET: 'this-is-a-long-enough-test-secret',
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

test('loadConfig refuses malformed values with a clear per-field message', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        SUPABASE_JWT_TEST_SECRET: 'too-short',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /SUPABASE_JWT_TEST_SECRET/)
      return true
    },
  )
})
