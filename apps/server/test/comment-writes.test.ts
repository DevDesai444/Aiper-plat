import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { setupTestDb, teardownTestDb, truncateAll, testDbConfig } from './helpers/testdb.js'

const SECRET = 'test-secret-plenty-long-enough-for-hs256'
const ISSUER = 'https://test-project.supabase.co/auth/v1'

let db: pg.Pool
let app: FastifyInstance

before(async () => {
  db = await setupTestDb()
  const t = testDbConfig()
  const config: Config = {
    PORT: 0,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    AIPER_ORG_NAME: 'Aiper',
    SUPABASE_JWT_TEST_SECRET: SECRET,
    SUPABASE_JWT_ISSUER: ISSUER,
    PGHOST: t.host,
    PGPORT: t.port,
    PGUSER: t.user,
    PGPASSWORD: t.password,
    PGDATABASE: t.database,
    SNAPSHOT_AUTO_INTERVAL_MS: 30_000,
  }
  app = await buildServer(config, db)
})
after(async () => {
  await app.close()
  await teardownTestDb(db)
})
beforeEach(async () => {
  await truncateAll(db)
})

// ------------------------------------------------------------ fixtures

async function signToken(sub: string, email: string, displayName: string): Promise<string> {
  return new SignJWT({ sub, email, user_metadata: { name: displayName } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

interface SeededUser {
  id: string
  email: string
  displayName: string
  token: string
}

async function seedUser(email: string, displayName: string): Promise<SeededUser> {
  const id = randomUUID()
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    id, email, displayName,
  ])
  return { id, email, displayName, token: await signToken(id, email, displayName) }
}

async function seedOrg(name: string): Promise<string> {
  const id = randomUUID()
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    id, name, name.toLowerCase().replace(/\s+/g, '-'),
  ])
  return id
}

async function joinOrg(orgId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
    [orgId, userId],
  )
}

async function grantDirect(
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
  userId: string,
  role: 'viewer' | 'editor' | 'owner',
  grantedBy: string,
): Promise<void> {
  await db.query(
    `INSERT INTO access_grants
       (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ($1::aiper_subject, $2, 'user', $3::text, $4::aiper_role, $5)`,
    [subjectType, subjectId, userId, role, grantedBy],
  )
}

/**
 * Standard fixture: Alice owns a project + folder + document via creator-
 * auto-owns. Bob and Carol are org members with no grants yet — tests
 * add whatever grant they need.
 */
async function aliceOwnsADocument(): Promise<{
  alice: SeededUser
  bob: SeededUser
  carol: SeededUser
  docId: string
}> {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const carol = await seedUser('carol@example.com', 'Carol')
  const org = await seedOrg('Acme')
  for (const u of [alice, bob, carol]) await joinOrg(org, u.id)
  const project = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [project, org, 'MISSION-X', 'mission-x', alice.id],
  )
  const folder = randomUUID()
  await db.query(
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, NULL, $3, $4)',
    [folder, project, 'TCS', alice.id],
  )
  const docId = randomUUID()
  await db.query(
    "INSERT INTO documents (id, folder_id, title, kind, created_by) VALUES ($1, $2, $3, 'authored', $4)",
    [docId, folder, 'TVAC Report', alice.id],
  )
  return { alice, bob, carol, docId }
}

async function commentsFor(docId: string) {
  const r = await db.query<{
    mark_id: string
    body: string
    author_id: string
    author_display_name: string
    resolved_at: Date | null
  }>(
    `SELECT mark_id, body, author_id, author_display_name, resolved_at
       FROM comments WHERE document_id = $1 ORDER BY created_at ASC`,
    [docId],
  )
  return r.rows
}

async function auditFor(docId: string) {
  const r = await db.query(
    `SELECT action, user_id, new_value, old_value
       FROM audit_log
      WHERE subject_type = 'document' AND subject_id = $1
      ORDER BY id ASC`,
    [docId],
  )
  return r.rows as Array<{ action: string; user_id: string; new_value: unknown; old_value: unknown }>
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// POST /api/v1/documents/:did/comments
// ============================================================================

test('POST comment — 401 without JWT', async () => {
  const { docId } = await aliceOwnsADocument()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments`,
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'b' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST comment — 403 for viewer, 201 for editor with denormalized author_display_name', async () => {
  const { alice, bob, docId } = await aliceOwnsADocument()

  // Viewer refused.
  await grantDirect('document', docId, bob.id, 'viewer', alice.id)
  const viewerRes = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(bob.token),
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'first pass' },
  })
  assert.equal(viewerRes.statusCode, 403)

  // Editor accepted; author_display_name comes from req.user.displayName.
  await db.query(
    `UPDATE access_grants SET role = 'editor'
      WHERE subject_type = 'document' AND subject_id = $1 AND principal_id = $2::text`,
    [docId, bob.id],
  )
  const editorRes = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(bob.token),
    payload: { markId: 'yjs-1', quotedText: 'The radiator', body: 'Should this be 1.4 m²?' },
  })
  assert.equal(editorRes.statusCode, 201)
  const created = editorRes.json()
  assert.equal(created.authorId, bob.id)
  assert.equal(created.authorDisplayName, 'Bob', 'denormalized from JWT displayName')
  assert.equal(created.markId, 'yjs-1')
  assert.equal(created.resolvedAt, null)

  const audit = await auditFor(docId)
  const added = audit.find((r) => r.action === 'comment.added')
  assert.ok(added, 'comment.added audit row written')
})

test('POST comment — multiple comments on the same markId form a thread', async () => {
  const { alice, docId } = await aliceOwnsADocument()

  for (const body of ['first', 'second', 'third']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/comments`,
      headers: authHeaders(alice.token),
      payload: { markId: 'yjs-thread', quotedText: 'q', body },
    })
    assert.equal(res.statusCode, 201)
  }

  const rows = await commentsFor(docId)
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.mark_id === 'yjs-thread'))
})

// ============================================================================
// POST /api/v1/documents/:did/comments/:markId/resolve
// ============================================================================

test('POST /resolve — 200 marks unresolved rows resolved; idempotent on re-run', async () => {
  const { alice, bob, docId } = await aliceOwnsADocument()
  await grantDirect('document', docId, bob.id, 'editor', alice.id)

  // Bob posts two comments on the same mark.
  for (const body of ['first', 'second']) {
    await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/comments`,
      headers: authHeaders(bob.token),
      payload: { markId: 'yjs-1', quotedText: 'q', body },
    })
  }

  // Alice (owner via auto-owns, and therefore editor+) resolves.
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments/yjs-1/resolve`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.comments.length, 2)
  assert.ok(body.comments.every((c: { resolvedAt: string | null }) => c.resolvedAt !== null))
  assert.ok(body.comments.every((c: { resolvedBy: string | null }) => c.resolvedBy === alice.id))

  const audit = await auditFor(docId)
  assert.ok(audit.some((r) => r.action === 'comment.resolved'))

  // Re-resolve returns current state without re-stamping resolvedBy.
  const originalResolvedBy = body.comments[0].resolvedBy
  const res2 = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments/yjs-1/resolve`,
    headers: authHeaders(bob.token),  // different editor
  })
  assert.equal(res2.statusCode, 200)
  const body2 = res2.json()
  assert.equal(body2.comments[0].resolvedBy, originalResolvedBy, 'idempotent: original resolver kept')

  // Only one resolve audit row for the whole thread.
  const audit2 = await auditFor(docId)
  const resolves = audit2.filter((r) => r.action === 'comment.resolved')
  assert.equal(resolves.length, 1, 'no duplicate audit row on idempotent re-resolve')
})

test('POST /resolve — 403 for viewer, 404 when no comment matches', async () => {
  const { alice, bob, docId } = await aliceOwnsADocument()
  await grantDirect('document', docId, bob.id, 'viewer', alice.id)

  // 403 viewer
  const viewerRes = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments/yjs-1/resolve`,
    headers: authHeaders(bob.token),
  })
  assert.equal(viewerRes.statusCode, 403)

  // 404 nothing to resolve
  const missingRes = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments/never-existed/resolve`,
    headers: authHeaders(alice.token),
  })
  assert.equal(missingRes.statusCode, 404)
})

// ============================================================================
// DELETE /api/v1/documents/:did/comments/:markId
// ============================================================================

test('DELETE — 204 when caller is the author of every matching comment', async () => {
  const { alice, bob, docId } = await aliceOwnsADocument()
  await grantDirect('document', docId, bob.id, 'editor', alice.id)

  await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(bob.token),
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'mine' },
  })

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${docId}/comments/yjs-1`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 204)
  assert.equal((await commentsFor(docId)).length, 0)
  assert.ok((await auditFor(docId)).some((r) => r.action === 'comment.deleted'))
})

test('DELETE — 204 when caller is the doc owner, even if they did not author', async () => {
  const { alice, bob, docId } = await aliceOwnsADocument()
  await grantDirect('document', docId, bob.id, 'editor', alice.id)

  await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(bob.token),
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'bobs comment' },
  })

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${docId}/comments/yjs-1`,
    headers: authHeaders(alice.token),  // alice = doc owner via auto-owns
  })
  assert.equal(res.statusCode, 204)
  assert.equal((await commentsFor(docId)).length, 0)

  const del = (await auditFor(docId)).find((r) => r.action === 'comment.deleted')
  assert.equal((del!.old_value as { byOwner: boolean }).byOwner, true, 'audit records this was an owner-delete')
})

test('DELETE — 403 for an editor who is neither author nor owner', async () => {
  const { alice, bob, carol, docId } = await aliceOwnsADocument()
  await grantDirect('document', docId, bob.id, 'editor', alice.id)
  await grantDirect('document', docId, carol.id, 'editor', alice.id)

  // Bob posts a comment; Carol (also editor, not owner, not author) tries to delete.
  await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(bob.token),
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'bobs' },
  })

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${docId}/comments/yjs-1`,
    headers: authHeaders(carol.token),
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'not_author')
  assert.equal((await commentsFor(docId)).length, 1, 'comment survives the refused delete')
})

test('DELETE — 403 when caller authored some but not all comments in the thread', async () => {
  const { alice, bob, carol, docId } = await aliceOwnsADocument()
  // Bob and Carol are editors on the document; neither owns. Alice owns
  // via the whole creator-auto-owns chain (project → folder → document).
  await grantDirect('document', docId, bob.id,   'editor', alice.id)
  await grantDirect('document', docId, carol.id, 'editor', alice.id)

  // Bob and Carol each post one comment on the same mark.
  await app.inject({
    method: 'POST', url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(bob.token),
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'bobs' },
  })
  await app.inject({
    method: 'POST', url: `/api/v1/documents/${docId}/comments`,
    headers: authHeaders(carol.token),
    payload: { markId: 'yjs-1', quotedText: 'q', body: 'carols' },
  })

  // Carol authored one comment but not Bob's — and she isn't the doc
  // owner (Alice is via auto-owns). Delete must refuse.
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${docId}/comments/yjs-1`,
    headers: authHeaders(carol.token),
  })
  assert.equal(res.statusCode, 403)
  assert.equal((await commentsFor(docId)).length, 2, 'nothing deleted on the refused delete')
})

test('DELETE — 404 when no comment matches the markId', async () => {
  const { alice, docId } = await aliceOwnsADocument()
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${docId}/comments/never-existed`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
})
