import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AiperRoleSchema,
  AiperSubjectSchema,
  ApiErrorSchema,
  SessionUserSchema,
} from '../src/schemas/index.js'

test('AiperRoleSchema accepts the three roles', () => {
  assert.equal(AiperRoleSchema.parse('viewer'), 'viewer')
  assert.equal(AiperRoleSchema.parse('editor'), 'editor')
  assert.equal(AiperRoleSchema.parse('owner'), 'owner')
})

test('AiperRoleSchema rejects other values', () => {
  assert.throws(() => AiperRoleSchema.parse('admin'))
  assert.throws(() => AiperRoleSchema.parse(''))
  assert.throws(() => AiperRoleSchema.parse(null))
})

test('AiperSubjectSchema accepts the three subject types', () => {
  assert.equal(AiperSubjectSchema.parse('project'), 'project')
  assert.equal(AiperSubjectSchema.parse('folder'), 'folder')
  assert.equal(AiperSubjectSchema.parse('document'), 'document')
})

test('SessionUserSchema parses a well-formed user', () => {
  const parsed = SessionUserSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    email: 'p1@example.com',
    displayName: 'P1',
    avatarUrl: null,
    orgMemberships: [
      { orgId: '22222222-2222-2222-2222-222222222222', role: 'member' },
    ],
  })
  assert.equal(parsed.email, 'p1@example.com')
  assert.equal(parsed.orgMemberships.length, 1)
  assert.equal(parsed.orgMemberships[0]?.role, 'member')
})

test('SessionUserSchema rejects malformed users', () => {
  assert.throws(() => SessionUserSchema.parse({ id: 'not-a-uuid' }))
  assert.throws(() =>
    SessionUserSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'not-an-email',
      displayName: 'P1',
      avatarUrl: null,
      orgMemberships: [],
    }),
  )
})

test('ApiErrorSchema parses minimal and full errors', () => {
  assert.deepEqual(ApiErrorSchema.parse({ error: 'nope' }), { error: 'nope' })
  assert.deepEqual(ApiErrorSchema.parse({ error: 'nope', code: 'NOPE' }), {
    error: 'nope',
    code: 'NOPE',
  })
})
