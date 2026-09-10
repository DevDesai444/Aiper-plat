/**
 * Save flow — POST /api/v1/documents/:did/save +
 * GET /api/v1/documents/:did/snapshots/:sid/state.
 *
 * Pattern mirrors apps/server/test/read-routes.test.ts landed in E2's
 * PR-7 (commit c861bff): a single buildServer + pool held across all
 * tests, JWTs signed inline with jose/HS256, seed helpers duplicated
 * from that file — a shared fixtures module is a follow-up when the
 * third HTTP test file appears.
 */

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { saveSnapshot } from '../src/snapshots.js'
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
    SUPABASE_JWT_TEST_SECRET: SECRET,
    SUPABASE_JWT_ISSUER: ISSUER,
    PGHOST: t.host,
    PGPORT: t.port,
    PGUSER: t.user,
    PGPASSWORD: t.password,
    PGDATABASE: t.database,
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
  email: string
  displayName: string
  token: string
}

async function seedUser(email: string, displayName: string): Promise<SeededUser> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    [id, email, displayName],
  )
  const token = await signToken(id, email, displayName)
  return { id, email, displayName, token }
}

async function seedOrg(name: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)',
    [id, name, name.toLowerCase().replace(/\s+/g, '-')],
  )
  return id
}

async function seedProject(orgId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, orgId, name, name.toLowerCase().replace(/\s+/g, '-'), createdBy],
  )
  return id
}

async function seedFolder(projectId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO folders (id, project_id, parent_folder_id, name, created_by)
       VALUES ($1, $2, NULL, $3, $4)`,
    [id, projectId, name, createdBy],
  )
  return id
}

async function seedDocument(folderId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, $3, 'authored', $4)`,
    [id, folderId, title, createdBy],
  )
  return id
}

/** Explicit grant — creator-auto-owns fires only for the doc's created_by,
 *  so anyone else needs an explicit access_grants row to be reachable. */
async function grantRole(
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
  userId: string,
  role: 'viewer' | 'editor' | 'owner',
  granter: string,
): Promise<void> {
  await db.query(
    `INSERT INTO access_grants
       (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ($1, $2, 'user', $3::text, $4, $5)`,
    [subjectType, subjectId, userId, role, granter],
  )
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// Compact fixture — Alice = owner of doc via auto-owns.
async function seedAliceDoc(): Promise<{
  alice: SeededUser
  org: string
  project: string
  folder: string
  doc: string
}> {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id)
  return { alice, org, project, folder, doc }
}

// Tiny "Yjs state" — the route treats the bytes opaquely; any non-empty
// buffer exercises the storage path and the byte-exact GET /state check.
const YJS_BYTES = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])
const YJS_BYTES_B64 = YJS_BYTES.toString('base64')

// ============================================================================
// POST /api/v1/documents/:did/save
// ============================================================================

test('POST /save returns 401 without a JWT', async () => {
  const { doc } = await seedAliceDoc()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/save`,
    payload: { yjsState: YJS_BYTES_B64 },
  })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'no_session')
})

test('POST /save returns 404 for a bogus :did (existence-leak guard)', async () => {
  const { alice } = await seedAliceDoc()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${MISSING_UUID}/save`,
    headers: authHeaders(alice.token),
    payload: { yjsState: YJS_BYTES_B64 },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('POST /save returns 404 when caller has no grant at all on the doc', async () => {
  // "No access at all" collapses to 404 — the caller must not be able
  // to tell a real doc from a fake one on a WRITE route.
  const { doc } = await seedAliceDoc()
  const outsider = await seedUser('outsider@example.com', 'Outsider')

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/save`,
    headers: authHeaders(outsider.token),
    payload: { yjsState: YJS_BYTES_B64 },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('POST /save returns 403 for a viewer trying to save', async () => {
  const { alice, doc } = await seedAliceDoc()
  const bob = await seedUser('bob@example.com', 'Bob')
  await grantRole('document', doc, bob.id, 'viewer', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/save`,
    headers: authHeaders(bob.token),
    payload: { yjsState: YJS_BYTES_B64 },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'insufficient_role')
})

test('POST /save as editor writes snapshot + audit + current_snapshot_id atomically', async () => {
  const { alice, doc } = await seedAliceDoc()

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/save`,
    headers: authHeaders(alice.token),
    payload: {
      reason: 'Baseline reviewed by regulator',
      label: 'v1.0',
      yjsState: YJS_BYTES_B64,
    },
  })
  assert.equal(res.statusCode, 200)

  const body = res.json() as {
    id: string
    documentId: string
    savedBy: string
    savedAt: string
    reason: string
    label: string | null
  }
  assert.equal(body.documentId, doc)
  assert.equal(body.savedBy, alice.id)
  assert.equal(body.reason, 'checkpoint')
  assert.equal(body.label, 'v1.0')
  assert.match(body.savedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  // Snapshot row landed with the exact bytes.
  const snap = await db.query<{ yjs_state: Buffer; reason: string; label: string | null }>(
    `SELECT yjs_state, reason, label FROM document_snapshots WHERE id = $1`,
    [body.id],
  )
  assert.equal(snap.rowCount, 1)
  assert.deepEqual(snap.rows[0]!.yjs_state, YJS_BYTES)
  assert.equal(snap.rows[0]!.reason, 'checkpoint')
  assert.equal(snap.rows[0]!.label, 'v1.0')

  // Audit row landed — one row, chained (prev_hash null for a first
  // event), with the user-supplied reason and newValue payload.
  const audit = await db.query<{
    action: string
    subject_type: string
    subject_id: string
    reason: string | null
    new_value: { snapshotId: string; label: string | null }
    user_id: string
    printed_name: string
    prev_hash: string | null
    row_hash: string
  }>(`SELECT * FROM audit_log ORDER BY id ASC`)
  assert.equal(audit.rowCount, 1)
  assert.equal(audit.rows[0]!.action, 'document.saved')
  assert.equal(audit.rows[0]!.subject_type, 'document')
  assert.equal(audit.rows[0]!.subject_id, doc)
  assert.equal(audit.rows[0]!.reason, 'Baseline reviewed by regulator')
  assert.deepEqual(audit.rows[0]!.new_value, {
    snapshotId: body.id,
    label: 'v1.0',
  })
  assert.equal(audit.rows[0]!.user_id, alice.id)
  assert.equal(audit.rows[0]!.printed_name, 'Alice')
  assert.equal(audit.rows[0]!.prev_hash, null)

  // documents pointer + updated_at both moved.
  const docRow = await db.query<{
    current_snapshot_id: string | null
    updated_at: Date
    created_at: Date
  }>(
    `SELECT current_snapshot_id, updated_at, created_at FROM documents WHERE id = $1`,
    [doc],
  )
  assert.equal(docRow.rows[0]!.current_snapshot_id, body.id)
  assert.ok(
    docRow.rows[0]!.updated_at.getTime() >= docRow.rows[0]!.created_at.getTime(),
    'updated_at moved forward on save',
  )
})

test('POST /save with an empty body still Saves (unlabelled checkpoint) — reason=null, label=null', async () => {
  const { alice, doc } = await seedAliceDoc()

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/save`,
    headers: authHeaders(alice.token),
    payload: { yjsState: YJS_BYTES_B64 },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { label: string | null; reason: string }
  assert.equal(body.reason, 'checkpoint')
  assert.equal(body.label, null)

  const audit = await db.query<{ reason: string | null }>(
    `SELECT reason FROM audit_log ORDER BY id ASC`,
  )
  assert.equal(audit.rowCount, 1)
  assert.equal(audit.rows[0]!.reason, null)
})

test('POST /save rejects a malformed base64 yjsState with 400', async () => {
  const { alice, doc } = await seedAliceDoc()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/save`,
    headers: authHeaders(alice.token),
    payload: { yjsState: 'not_valid_base64!!!' },
  })
  assert.equal(res.statusCode, 400)
})

// ============================================================================
// Service — reason='auto' skips audit (the durability path)
// ============================================================================

test('saveSnapshot service with reason="auto" writes a snapshot but no audit row', async () => {
  const { alice, doc } = await seedAliceDoc()

  const snap = await saveSnapshot(db, doc, YJS_BYTES, {
    reason: 'auto',
    label: null,
    userReason: null,
    actor: { id: alice.id, printedName: 'Alice' },
  })
  assert.equal(snap.reason, 'auto')
  assert.equal(snap.label, null)

  const auditCount = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log`,
  )
  assert.equal(auditCount.rows[0]!.n, '0', 'auto-save must not write to audit_log')

  const snapCount = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_snapshots`,
  )
  assert.equal(snapCount.rows[0]!.n, '1', 'the snapshot itself still lands')
})

test('saveSnapshot service with reason="release" DOES audit', async () => {
  // Confirms the split: only 'auto' is silent; 'checkpoint' and 'release'
  // both audit. Kickoff Q2 answer.
  const { alice, doc } = await seedAliceDoc()

  await saveSnapshot(db, doc, YJS_BYTES, {
    reason: 'release',
    label: 'v1.0',
    userReason: 'Shipped',
    actor: { id: alice.id, printedName: 'Alice' },
  })

  const audit = await db.query<{ action: string; reason: string | null }>(
    `SELECT action, reason FROM audit_log`,
  )
  assert.equal(audit.rowCount, 1)
  assert.equal(audit.rows[0]!.action, 'document.saved')
  assert.equal(audit.rows[0]!.reason, 'Shipped')
})

// ============================================================================
// GET /api/v1/documents/:did/snapshots/:sid/state
// ============================================================================

test('GET /state returns 401 without a JWT', async () => {
  const { alice, doc } = await seedAliceDoc()
  const snap = await saveSnapshot(db, doc, YJS_BYTES, {
    reason: 'checkpoint',
    label: null,
    userReason: null,
    actor: { id: alice.id, printedName: 'Alice' },
  })
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/snapshots/${snap.id}/state`,
  })
  assert.equal(res.statusCode, 401)
})

test('GET /state returns exact bytes for a viewer', async () => {
  const { alice, doc } = await seedAliceDoc()
  const bob = await seedUser('bob@example.com', 'Bob')
  await grantRole('document', doc, bob.id, 'viewer', alice.id)

  const snap = await saveSnapshot(db, doc, YJS_BYTES, {
    reason: 'checkpoint',
    label: 'v1',
    userReason: null,
    actor: { id: alice.id, printedName: 'Alice' },
  })

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/snapshots/${snap.id}/state`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['cache-control'], 'private, no-store')
  // rawPayload preserves the exact bytes fastify.inject wrote; .payload
  // decodes as a string and would corrupt binary data.
  assert.deepEqual(res.rawPayload, YJS_BYTES)
})

test('GET /state returns 404 when caller has no grant on the doc', async () => {
  const { alice, doc } = await seedAliceDoc()
  const outsider = await seedUser('outsider@example.com', 'Outsider')

  const snap = await saveSnapshot(db, doc, YJS_BYTES, {
    reason: 'checkpoint',
    label: null,
    userReason: null,
    actor: { id: alice.id, printedName: 'Alice' },
  })

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/snapshots/${snap.id}/state`,
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('GET /state returns 404 when :sid belongs to another :did (URL-leak guard)', async () => {
  // Alice owns two docs; snap lives on docA. A caller who legitimately
  // accesses docB cannot replay snap.id under docB's URL to gain the
  // bytes — the snapshot's document_id must match :did.
  const { alice, folder } = await seedAliceDoc()
  const docA = await seedDocument(folder, 'TVAC Report A', alice.id)
  const docB = await seedDocument(folder, 'TVAC Report B', alice.id)

  const snap = await saveSnapshot(db, docA, YJS_BYTES, {
    reason: 'checkpoint',
    label: null,
    userReason: null,
    actor: { id: alice.id, printedName: 'Alice' },
  })

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${docB}/snapshots/${snap.id}/state`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('GET /state returns 404 for a non-existent :sid on a real :did', async () => {
  const { alice, doc } = await seedAliceDoc()
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/snapshots/${MISSING_UUID}/state`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})
