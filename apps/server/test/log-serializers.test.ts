/**
 * Unit tests for the pino req serialiser wired into the Fastify logger
 * config. The WS handshake for /ws carries the Supabase JWT in its
 * query string (browsers can't set Authorization on WebSockets), and
 * without redaction the bearer would land in the log store on every
 * connect.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactTokenInUrl, reqSerializer } from '../src/log-serializers.js'

test('redactTokenInUrl replaces the token param value', () => {
  const out = redactTokenInUrl('/ws?token=eyJhbGciOiJIUzI1NiJ9.abcdef&doc=11111111-1111-1111-1111-111111111111')
  assert.match(out, /token=REDACTED/)
  assert.doesNotMatch(out, /eyJ/, 'the actual token string is gone')
  assert.match(out, /doc=11111111-1111-1111-1111-111111111111/, 'other params kept intact')
})

test('redactTokenInUrl passes through a URL with no query string', () => {
  assert.equal(redactTokenInUrl('/api/v1/documents/abc'), '/api/v1/documents/abc')
})

test('redactTokenInUrl passes through a URL whose query has no token param', () => {
  assert.equal(redactTokenInUrl('/api/v1/audit?limit=50'), '/api/v1/audit?limit=50')
})

test('redactTokenInUrl handles a URL whose only param is token', () => {
  const out = redactTokenInUrl('/ws?token=whatever')
  assert.equal(out, '/ws?token=REDACTED')
})

test('reqSerializer redacts the token in the url field while preserving the rest', () => {
  const out = reqSerializer({
    method: 'GET',
    url: '/ws?token=SECRET&doc=xyz',
    hostname: '127.0.0.1',
    ip: '::1',
    socket: { remotePort: 51234 },
  })
  assert.equal(out.method, 'GET')
  assert.equal(out.hostname, '127.0.0.1')
  assert.equal(out.remoteAddress, '::1')
  assert.equal(out.remotePort, 51234)
  assert.doesNotMatch(out.url, /SECRET/)
  assert.match(out.url, /token=REDACTED/)
})

test('reqSerializer tolerates a missing url', () => {
  // Pino calls this on any object shaped like a request; defensive
  // handling means a probe or an internal call without url still
  // serialises without throwing.
  const out = reqSerializer({ method: 'HEAD' })
  assert.equal(out.url, '')
  assert.equal(out.method, 'HEAD')
})
