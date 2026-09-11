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
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, NULL, $3, $4)',
    [id, projectId, name, createdBy],
  )
  return id
}

async function seedDocInFolder(folderId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO documents (id, folder_id, title, kind, created_by) VALUES ($1, $2, $3, 'authored', $4)",
    [id, folderId, title, createdBy],
  )
  return id
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
// POST /:did/links
// ============================================================================

test('POST /links — 401 without JWT', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${randomUUID()}/links`,
    payload: { targetDocumentId: randomUUID(), relation: 'references' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /links — 201 creates link; response carries counterpart + audit lands on SOURCE', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const source = await seedDocInFolder(folder, 'TVAC Report', alice.id)
  const target = await seedDocInFolder(folder, 'Thermal Spec', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${source}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: target, relation: 'verifies' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.relation, 'verifies')
  assert.equal(body.counterpart.id, target)
  assert.equal(body.counterpart.title, 'Thermal Spec')
  assert.equal(body.counterpart.projectName, 'MISSION-X')
  assert.equal(body.counterpartRole, 'owner')
  assert.equal(body.createdBy, alice.id)

  // Audit anchors on the SOURCE (peer's locked shape), not on the link.
  const audit = await auditFor('document', source)
  const created = audit.find((r) => r.action === 'doc-link.created')
  assert.ok(created, 'doc-link.created audit row anchored on source')
  assert.equal((created!.new_value as { targetDocumentId: string; relation: string }).targetDocumentId, target)
  assert.equal((created!.new_value as { targetDocumentId: string; relation: string }).relation, 'verifies')
})

test('POST /links — 400 self_link when source == target', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc = await seedDocInFolder(folder, 'D', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: doc, relation: 'references' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'self_link')
})

test('POST /links — 409 duplicate (source, target, relation)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)
  const tgt = await seedDocInFolder(folder, 'B', alice.id)

  const post = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/documents/${src}/links`,
      headers: authHeaders(alice.token),
      payload: { targetDocumentId: tgt, relation: 'verifies' },
    })
  assert.equal((await post()).statusCode, 201)
  const second = await post()
  assert.equal(second.statusCode, 409)
  assert.equal(second.json().code, 'duplicate_link')
})

test('POST /links — same pair, different relations both accepted', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)
  const tgt = await seedDocInFolder(folder, 'B', alice.id)

  for (const relation of ['verifies', 'derives-from']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${src}/links`,
      headers: authHeaders(alice.token),
      payload: { targetDocumentId: tgt, relation },
    })
    assert.equal(res.statusCode, 201)
  }
})

test('POST /links — 403 for viewer of source (needs editor+ on source)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)
  const tgt = await seedDocInFolder(folder, 'B', alice.id)
  await grantDirect('document', src, bob.id, 'viewer', alice.id)
  await grantDirect('document', tgt, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${src}/links`,
    headers: authHeaders(bob.token),
    payload: { targetDocumentId: tgt, relation: 'references' },
  })
  assert.equal(res.statusCode, 403, 'viewer of source cannot link outward')
})

test('POST /links — 403 when target is not visible to caller', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)
  const tgt = await seedDocInFolder(folder, 'B', alice.id)  // Bob has no grant on tgt
  await grantDirect('document', src, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${src}/links`,
    headers: authHeaders(bob.token),
    payload: { targetDocumentId: tgt, relation: 'references' },
  })
  assert.equal(res.statusCode, 403, 'no linking to what you cannot see')
})

test('POST /links — cross-project link accepted when caller sees both docs', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const p1 = await seedProject(org, 'Proj 1', alice.id)
  const p2 = await seedProject(org, 'Proj 2', alice.id)
  const src = await seedDocInFolder(await seedFolder(p1, 'F1', alice.id), 'Src', alice.id)
  const tgt = await seedDocInFolder(await seedFolder(p2, 'F2', alice.id), 'Tgt', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${src}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: tgt, relation: 'references' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.counterpart.projectId, p2)
})

// ============================================================================
// DELETE /:did/links/:linkId
// ============================================================================

test('DELETE /links/:linkId — 204 removes link + audit', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)
  const tgt = await seedDocInFolder(folder, 'B', alice.id)

  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${src}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: tgt, relation: 'verifies' },
  })
  const linkId = created.json().id

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${src}/links/${linkId}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(del.statusCode, 204)

  const remaining = await db.query(`SELECT 1 FROM document_links WHERE id = $1`, [linkId])
  assert.equal(remaining.rowCount, 0)

  const audit = await auditFor('document', src)
  assert.ok(audit.some((r) => r.action === 'doc-link.deleted'))
})

test('DELETE /links/:linkId — 204 idempotent when the link does not belong to the source URL', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)

  // A random linkId that certainly doesn't belong to src.
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${src}/links/${randomUUID()}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 204)
})

test('DELETE /links/:linkId — target owner cannot delete inbound arrow they did not create', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')  // owns src
  const bob = await seedUser('bob@example.com', 'Bob')        // owns tgt (invited as its owner)
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'A', alice.id)
  const tgt = await seedDocInFolder(folder, 'B', alice.id)
  await grantDirect('document', tgt, bob.id, 'owner', alice.id)

  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${src}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: tgt, relation: 'verifies' },
  })
  const linkId = created.json().id

  // Bob owns tgt but cannot delete a link whose source (src) he isn't
  // even an editor of.
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/documents/${src}/links/${linkId}`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 403, 'target owner cannot erase inbound arrows on someone else\'s doc')
})

// ============================================================================
// GET /:did/links
// ============================================================================

test('GET /links — returns both outgoing and incoming with counterpart context', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const anchor = await seedDocInFolder(folder, 'anchor', alice.id)
  const outgoing1 = await seedDocInFolder(folder, 'Out A', alice.id)
  const outgoing2 = await seedDocInFolder(folder, 'Out B', alice.id)
  const incoming = await seedDocInFolder(folder, 'Incoming', alice.id)

  // anchor → outgoing1 (verifies), anchor → outgoing2 (references)
  for (const [t, r] of [
    [outgoing1, 'verifies'],
    [outgoing2, 'references'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${anchor}/links`,
      headers: authHeaders(alice.token),
      payload: { targetDocumentId: t, relation: r },
    })
  }
  // incoming → anchor
  await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${incoming}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: anchor, relation: 'derives-from' },
  })

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${anchor}/links`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as {
    outgoing: Array<{ counterpart: { id: string; title: string }; relation: string; counterpartRole: string }>
    incoming: Array<{ counterpart: { id: string; title: string }; relation: string; counterpartRole: string }>
  }
  assert.equal(body.outgoing.length, 2)
  // Sorted by lower(counterpart.title) ASC — "Out A" before "Out B".
  assert.equal(body.outgoing[0]!.counterpart.title, 'Out A')
  assert.equal(body.outgoing[0]!.relation, 'verifies')
  assert.equal(body.outgoing[1]!.counterpart.title, 'Out B')
  assert.equal(body.outgoing[1]!.relation, 'references')
  assert.ok(body.outgoing.every((l) => l.counterpartRole === 'owner'))

  assert.equal(body.incoming.length, 1)
  assert.equal(body.incoming[0]!.counterpart.id, incoming)
  assert.equal(body.incoming[0]!.relation, 'derives-from')
})

test('GET /links — filters counterparts the caller cannot see', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const anchor = await seedDocInFolder(folder, 'Anchor', alice.id)
  const hidden = await seedDocInFolder(folder, 'Hidden', alice.id)   // Bob has no grant
  const visible = await seedDocInFolder(folder, 'Visible', alice.id)

  // Alice links anchor → hidden AND anchor → visible.
  for (const t of [hidden, visible]) {
    await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${anchor}/links`,
      headers: authHeaders(alice.token),
      payload: { targetDocumentId: t, relation: 'references' },
    })
  }
  // Bob gets viewer on anchor + visible only.
  await grantDirect('document', anchor, bob.id, 'viewer', alice.id)
  await grantDirect('document', visible, bob.id, 'viewer', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${anchor}/links`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 200)
  const outgoing = res.json().outgoing as Array<{ counterpart: { id: string } }>
  assert.equal(outgoing.length, 1, 'the link to Hidden is filtered out')
  assert.equal(outgoing[0]!.counterpart.id, visible)
})

test('GET /links — mutual references (A→B and B→A) both surface on either doc', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const A = await seedDocInFolder(folder, 'A', alice.id)
  const B = await seedDocInFolder(folder, 'B', alice.id)

  // Same relation, both directions — legal per the design.
  for (const [s, t] of [
    [A, B],
    [B, A],
  ] as const) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${s}/links`,
      headers: authHeaders(alice.token),
      payload: { targetDocumentId: t, relation: 'references' },
    })
    assert.equal(r.statusCode, 201)
  }

  const fromA = (await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${A}/links`,
    headers: authHeaders(alice.token),
  })).json() as { outgoing: unknown[]; incoming: unknown[] }
  assert.equal(fromA.outgoing.length, 1)
  assert.equal(fromA.incoming.length, 1)
})

test('GET /links — cascade: deleting the source document removes its links', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const src = await seedDocInFolder(folder, 'Src', alice.id)
  const tgt = await seedDocInFolder(folder, 'Tgt', alice.id)

  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${src}/links`,
    headers: authHeaders(alice.token),
    payload: { targetDocumentId: tgt, relation: 'verifies' },
  })
  const linkId = created.json().id

  // Delete the source doc — CASCADE from document_links.source_document_id
  // should remove the link.
  await db.query(`DELETE FROM documents WHERE id = $1`, [src])
  const remaining = await db.query(`SELECT 1 FROM document_links WHERE id = $1`, [linkId])
  assert.equal(remaining.rowCount, 0)
})
