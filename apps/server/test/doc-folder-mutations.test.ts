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

async function seedProject(orgId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, orgId, name, name.toLowerCase().replace(/\s+/g, '-'), createdBy],
  )
  return id
}

async function seedFolder(
  projectId: string,
  parentFolderId: string | null,
  name: string,
  createdBy: string,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, projectId, parentFolderId, name, createdBy],
  )
  return id
}

async function seedDoc(parent: { folderId?: string; projectId?: string }, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, project_id, title, kind, created_by)
     VALUES ($1, $2, $3, $4, 'authored', $5)`,
    [id, parent.folderId ?? null, parent.projectId ?? null, title, createdBy],
  )
  return id
}

async function auditFor(subjectType: string, subjectId: string) {
  const r = await db.query(
    `SELECT action, user_id, new_value, old_value FROM audit_log
      WHERE subject_type = $1::aiper_subject AND subject_id = $2 ORDER BY id ASC`,
    [subjectType, subjectId],
  )
  return r.rows as Array<{ action: string; user_id: string; new_value: unknown; old_value: unknown }>
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// PATCH /documents/:did — move
// ============================================================================

test('PATCH /documents/:did — 403 when editor tries to move (owner-only)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folderA = await seedFolder(project, null, 'A', alice.id)
  const folderB = await seedFolder(project, null, 'B', alice.id)
  const doc = await seedDoc({ folderId: folderA }, 'D', alice.id)
  await grantDirect('document', doc, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(bob.token),
    payload: { folderId: folderB },
  })
  assert.equal(res.statusCode, 403)
})

test('PATCH /documents/:did — 400 when both folderId and projectId present', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)
  const doc = await seedDoc({ folderId: folder }, 'D', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(alice.token),
    payload: { folderId: folder, projectId: project },
  })
  assert.equal(res.statusCode, 400, 'Zod refine rejects both-set')
})

test('PATCH /documents/:did — 400 cross-project move refused', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const p1 = await seedProject(org, 'P1', alice.id)
  const p2 = await seedProject(org, 'P2', alice.id)
  const folderInP1 = await seedFolder(p1, null, 'A', alice.id)
  const folderInP2 = await seedFolder(p2, null, 'B', alice.id)
  const doc = await seedDoc({ folderId: folderInP1 }, 'D', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(alice.token),
    payload: { folderId: folderInP2 },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'cross_project_move')
})

test('PATCH /documents/:did — 200 move folder → project honors migration 009 CHECK', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)
  const doc = await seedDoc({ folderId: folder }, 'D', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(alice.token),
    payload: { projectId: project },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.folderId, null)
  assert.equal(body.projectId, project, 'flipped to project parent')

  // Confirm the DB row satisfies documents_one_parent_chk (exactly one set).
  const row = await db.query<{ folder_id: string | null; project_id: string | null }>(
    `SELECT folder_id, project_id FROM documents WHERE id = $1`,
    [doc],
  )
  assert.equal(row.rows[0]!.folder_id, null)
  assert.equal(row.rows[0]!.project_id, project)

  const audit = auditFor('document', doc)
  assert.ok((await audit).some((r) => r.action === 'document.moved'))
})

test('PATCH /documents/:did — 200 move project → folder within the same project', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)
  const doc = await seedDoc({ projectId: project }, 'D', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(alice.token),
    payload: { folderId: folder },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().folderId, folder)
  assert.equal(res.json().projectId, null)
})

// ============================================================================
// DELETE /documents/:did
// ============================================================================

test('DELETE /documents/:did — 403 for editor (owner-only)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)
  const doc = await seedDoc({ folderId: folder }, 'D', alice.id)
  await grantDirect('document', doc, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 403)
})

test('DELETE /documents/:did — 204 by owner; comments cascade; audit lands', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)
  const doc = await seedDoc({ folderId: folder }, 'D', alice.id)
  // Add a comment to prove ON DELETE CASCADE actually fires.
  await db.query(
    `INSERT INTO comments
       (document_id, mark_id, quoted_text, body, author_id, author_display_name)
     VALUES ($1, 'yjs-1', 'q', 'b', $2, 'Alice')`,
    [doc, alice.id],
  )

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/documents/${doc}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 204)

  const remainingDoc = await db.query(`SELECT 1 FROM documents WHERE id = $1`, [doc])
  assert.equal(remainingDoc.rowCount, 0)
  const remainingComments = await db.query(`SELECT 1 FROM comments WHERE document_id = $1`, [doc])
  assert.equal(remainingComments.rowCount, 0, 'CASCADE removed comments')

  // Audit row lands before the DELETE so the deleted subject's history is preserved.
  const audit = await auditFor('document', doc)
  assert.ok(audit.some((r) => r.action === 'document.deleted'))
})

// ============================================================================
// PATCH /folders/:fid — cycle guard
// ============================================================================

test('PATCH /folders/:fid — 400 folder_cycle when moving parent under a descendant', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  //          root
  //           |
  //          child
  //           |
  //          grand
  const root = await seedFolder(project, null, 'root', alice.id)
  const child = await seedFolder(project, root, 'child', alice.id)
  const grand = await seedFolder(project, child, 'grand', alice.id)

  // Try to make `root` a child of `grand` — that would make grand its own ancestor.
  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/folders/${root}`,
    headers: authHeaders(alice.token),
    payload: { parentFolderId: grand },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'folder_cycle')
})

test('PATCH /folders/:fid — 400 self_parent when moving under itself', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/folders/${folder}`,
    headers: authHeaders(alice.token),
    payload: { parentFolderId: folder },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'self_parent')
})

test('PATCH /folders/:fid — 403 when editor tries to move (owner-only)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const src = await seedFolder(project, null, 'src', alice.id)
  const dst = await seedFolder(project, null, 'dst', alice.id)
  await grantDirect('folder', src, bob.id, 'editor', alice.id)
  await grantDirect('folder', dst, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/folders/${src}`,
    headers: authHeaders(bob.token),
    payload: { parentFolderId: dst },
  })
  assert.equal(res.statusCode, 403, 'editor cannot move — owner-only')
})

// ============================================================================
// DELETE /folders/:fid
// ============================================================================

test('DELETE /folders/:fid — 204 by owner; children + docs cascade', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const parent = await seedFolder(project, null, 'parent', alice.id)
  const child = await seedFolder(project, parent, 'child', alice.id)
  const docInParent = await seedDoc({ folderId: parent }, 'DP', alice.id)
  const docInChild = await seedDoc({ folderId: child }, 'DC', alice.id)

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/folders/${parent}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 204)

  const folders = await db.query(`SELECT id FROM folders WHERE id IN ($1, $2)`, [parent, child])
  assert.equal(folders.rowCount, 0, 'parent and child both deleted via CASCADE')

  const docs = await db.query(`SELECT id FROM documents WHERE id IN ($1, $2)`, [docInParent, docInChild])
  assert.equal(docs.rowCount, 0, 'docs under both folders deleted via CASCADE')

  assert.ok((await auditFor('folder', parent)).some((r) => r.action === 'folder.deleted'))
})

test('DELETE /folders/:fid — 403 for editor', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'A', alice.id)
  await grantDirect('folder', folder, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/folders/${folder}`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 403)
})
