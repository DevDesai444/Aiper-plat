/**
 * GET /api/v1/documents/:did/history — Save-timeline read.
 *
 * Pattern matches save-flow.test.ts and read-routes.test.ts: one shared
 * buildServer + pool for the whole file, JWTs signed with jose/HS256,
 * seed helpers inline. Snapshots are inserted directly via SQL rather
 * than through POST /save so the tests exercise the route in isolation
 * — a save-flow regression would surface separately in save-flow.test.ts.
 */

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
const MISSING_UUID = '99999999-9999-9999-9999-999999999999'

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

// ------------------------------------------------------------ fixture helpers

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
  displayName: string
  token: string
}

async function seedUser(email: string, displayName: string): Promise<SeededUser> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    [id, email, displayName],
  )
  return { id, displayName, token: await signToken(id, email, displayName) }
}

async function seedAliceDoc(): Promise<{ alice: SeededUser; doc: string }> {
  const alice = await seedUser('alice@example.com', 'Alice')
  const orgId = randomUUID()
  await db.query(
    'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)',
    [orgId, 'Acme', 'acme'],
  )
  const projectId = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [projectId, orgId, 'MISSION-X', 'mission-x', alice.id],
  )
  const folderId = randomUUID()
  await db.query(
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, NULL, $3, $4)',
    [folderId, projectId, 'TCS', alice.id],
  )
  const doc = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, 'TVAC Report', 'authored', $3)`,
    [doc, folderId, alice.id],
  )
  return { alice, doc }
}

async function grantViewer(doc: string, userId: string, granter: string): Promise<void> {
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('document', $1, 'user', $2::text, 'viewer', $3)`,
    [doc, userId, granter],
  )
}

/** Insert one snapshot row directly. Bytes are trivial — the history
 *  endpoint returns metadata only, so the payload content is irrelevant
 *  to what these tests assert. */
async function insertSnapshot(
  doc: string,
  savedBy: string,
  reason: 'auto' | 'checkpoint' | 'release',
  label: string | null,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO document_snapshots
       (id, document_id, yjs_state, reason, label, saved_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, doc, Buffer.from([0]), reason, label, savedBy],
  )
  return id
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// GET /api/v1/documents/:did/history
// ============================================================================

test('GET /history returns 401 without a JWT', async () => {
  const { doc } = await seedAliceDoc()
  const res = await app.inject({ method: 'GET', url: `/api/v1/documents/${doc}/history` })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'no_session')
})

test('GET /history returns 404 for a bogus :did (existence-leak guard)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${MISSING_UUID}/history`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('GET /history returns 404 when caller has no grant on the doc', async () => {
  // No-grant collapses to 404, not 403 — same guard as POST /save.
  const { doc } = await seedAliceDoc()
  const stranger = await seedUser('stranger@example.com', 'Stranger')
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/history`,
    headers: authHeaders(stranger.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('GET /history returns 200 for an owner, snapshots ordered saved_at DESC', async () => {
  const { alice, doc } = await seedAliceDoc()

  // Three snapshots in temporal order. Sleep between inserts so the
  // saved_at DEFAULT now() values are strictly monotonic; without a
  // pause fast machines land two inserts in the same microsecond and
  // the ORDER BY tiebreak becomes non-deterministic.
  const s1 = await insertSnapshot(doc, alice.id, 'auto', null)
  await new Promise((r) => setTimeout(r, 2))
  const s2 = await insertSnapshot(doc, alice.id, 'checkpoint', 'Baseline v1')
  await new Promise((r) => setTimeout(r, 2))
  const s3 = await insertSnapshot(doc, alice.id, 'auto', null)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/history`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as {
    snapshots: Array<{
      id: string
      documentId: string
      savedBy: string
      savedAt: string
      reason: string
      label: string | null
    }>
  }
  assert.equal(body.snapshots.length, 3)
  assert.deepEqual(
    body.snapshots.map((s) => s.id),
    [s3, s2, s1],
    'newest first',
  )
  assert.equal(body.snapshots[1]!.reason, 'checkpoint')
  assert.equal(body.snapshots[1]!.label, 'Baseline v1')
  assert.equal(body.snapshots[0]!.label, null)
})

test('GET /history returns the same list to a viewer', async () => {
  const { alice, doc } = await seedAliceDoc()
  const bob = await seedUser('bob@example.com', 'Bob')
  await grantViewer(doc, bob.id, alice.id)

  await insertSnapshot(doc, alice.id, 'checkpoint', 'v1')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/history`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { snapshots: Array<{ label: string | null }> }
  assert.equal(body.snapshots.length, 1)
  assert.equal(body.snapshots[0]!.label, 'v1')
})

test('GET /history response omits yjs_state (metadata only)', async () => {
  const { alice, doc } = await seedAliceDoc()
  await insertSnapshot(doc, alice.id, 'checkpoint', 'v1')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/history`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { snapshots: Array<Record<string, unknown>> }
  const keys = Object.keys(body.snapshots[0]!).sort()
  // Exact key set: no yjs_state, no anything else the frozen shape
  // doesn't declare. If a future PR adds a field, this assertion is
  // the reminder to update SnapshotList in @aiper/shared too.
  assert.deepEqual(keys, ['documentId', 'id', 'label', 'reason', 'savedAt', 'savedBy'])
})

test('GET /history returns an empty list for a document with no snapshots yet', async () => {
  const { alice, doc } = await seedAliceDoc()
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/history`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { snapshots: unknown[] }
  assert.deepEqual(body.snapshots, [])
})
