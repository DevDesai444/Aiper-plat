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
  email: string
  displayName: string
  token: string
}

/**
 * Insert a users row and sign a JWT for that same id. The auth middleware
 * will ON CONFLICT DO UPDATE the row on the first request — fine, the id
 * stays stable so anything else we inserted for this user (org_members,
 * grants, project.created_by) still points here.
 */
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

async function joinOrg(orgId: string, userId: string, role: 'admin' | 'member' = 'member'): Promise<void> {
  await db.query(
    'INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)',
    [orgId, userId, role],
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

async function seedDocument(
  folderId: string,
  title: string,
  createdBy: string,
  kind: 'authored' | 'technical-sheet' | 'template' = 'authored',
): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO documents (id, folder_id, title, kind, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, folderId, title, kind, createdBy],
  )
  return id
}

async function seedComment(
  documentId: string,
  authorId: string,
  authorDisplayName: string,
  body: string,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO comments
       (id, document_id, mark_id, quoted_text, body, author_id, author_display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, documentId, 'yjs-mark-' + id.slice(0, 8), 'q', body, authorId, authorDisplayName],
  )
  return id
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// GET /api/v1/orgs
// ============================================================================

test('GET /api/v1/orgs returns 401 without a JWT', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/orgs' })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'no_session')
})

test('GET /api/v1/orgs returns only the caller\'s orgs, alphabetical', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const orgA = await seedOrg('Zebra Corp')
  const orgB = await seedOrg('Acme Inc')
  const orgHidden = await seedOrg('Not Mine Ltd')
  await joinOrg(orgA, alice.id, 'member')
  await joinOrg(orgB, alice.id, 'admin')
  // orgHidden intentionally NOT joined

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/orgs',
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const items = res.json().items as Array<{ id: string; name: string }>
  assert.equal(items.length, 2, 'only member orgs returned')
  assert.equal(items[0]!.name, 'Acme Inc', 'alphabetical order')
  assert.equal(items[1]!.name, 'Zebra Corp')
  assert.ok(!items.some((o) => o.id === orgHidden))
})

// ============================================================================
// GET /api/v1/orgs/:oid/projects
// ============================================================================

test('GET /api/v1/orgs/:oid/projects — 404 for a random oid', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${MISSING_UUID}/projects`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('GET /api/v1/orgs/:oid/projects — 403 when caller is not a member', async () => {
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  // outsider not joined
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${org}/projects`,
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'no_access')
})

test('GET /api/v1/orgs/:oid/projects — returns only reachable projects', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)

  const aliceProject = await seedProject(org, 'Alice Project', alice.id)   // owner via auto-owns
  const bobProject = await seedProject(org, 'Bob Project', bob.id)         // alice has no grant

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${org}/projects`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const items = res.json().items as Array<{ id: string; myRole: string }>
  assert.equal(items.length, 1, 'unreachable project is filtered out')
  assert.equal(items[0]!.id, aliceProject)
  assert.equal(items[0]!.myRole, 'owner')
  assert.ok(!items.some((p) => p.id === bobProject))
})

// ============================================================================
// GET /api/v1/projects/:pid
// ============================================================================

test('GET /api/v1/projects/:pid — 404, 403, and 200 with myRole populated', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, outsider.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)

  // 404
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${MISSING_UUID}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 404)
  }
  // 403 — outsider is an org member but has no grant on this project
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project}`,
      headers: authHeaders(outsider.token),
    })
    assert.equal(res.statusCode, 403)
  }
  // 200 — creator is owner via auto-owns
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, project)
    assert.equal(body.orgId, org)
    assert.equal(body.slug, 'mission-x')
    assert.equal(body.myRole, 'owner')
  }
})

// ============================================================================
// GET /api/v1/projects/:pid/folders — the tree
// ============================================================================

test('GET /api/v1/projects/:pid/folders — DFS preorder, siblings alphabetical', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)

  //                project
  //                /      \
  //             TCS       ADCS
  //             /
  //          Thermal Analysis
  //             |
  //          Radiator Sizing.docx
  const tcs = await seedFolder(project, null, 'TCS', alice.id)
  const adcs = await seedFolder(project, null, 'ADCS', alice.id)   // alphabetically before TCS
  const thermal = await seedFolder(project, tcs, 'Thermal Analysis', alice.id)
  await seedDocument(thermal, 'Radiator Sizing', alice.id, 'authored')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/folders`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as {
    project: { id: string; myRole: string }
    folders: Array<{
      folder: { id: string; name: string; parentFolderId: string | null; myRole: string }
      children: Array<{ id: string; name: string }>
      documents: Array<{ id: string; title: string; kind: string }>
    }>
  }
  assert.equal(body.project.id, project)
  assert.equal(body.project.myRole, 'owner')

  // Expected DFS order: ADCS, TCS, Thermal Analysis (siblings sorted
  // alphabetically case-insensitively).
  assert.equal(body.folders.length, 3)
  assert.equal(body.folders[0]!.folder.id, adcs)
  assert.equal(body.folders[1]!.folder.id, tcs)
  assert.equal(body.folders[2]!.folder.id, thermal)

  // TCS carries Thermal Analysis as its child summary; Thermal Analysis
  // carries the one document.
  assert.deepEqual(
    body.folders[1]!.children.map((c) => c.id),
    [thermal],
  )
  assert.equal(body.folders[2]!.documents.length, 1)
  assert.equal(body.folders[2]!.documents[0]!.title, 'Radiator Sizing')
  assert.equal(body.folders[2]!.documents[0]!.kind, 'authored')
})

// ============================================================================
// GET /api/v1/folders/:fid + /folders/:fid/documents
// ============================================================================

test('GET /api/v1/folders/:fid — 404, 403, and 200 with myRole', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, outsider.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)

  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/folders/${MISSING_UUID}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 404)
  }
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/folders/${folder}`,
      headers: authHeaders(outsider.token),
    })
    assert.equal(res.statusCode, 403)
  }
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/folders/${folder}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, folder)
    assert.equal(body.projectId, project)
    assert.equal(body.myRole, 'owner')
  }
})

test('GET /api/v1/folders/:fid/documents — lists documents in the folder', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)
  await seedDocument(folder, 'Zeta Report', alice.id, 'authored')
  await seedDocument(folder, 'Alpha Draft', alice.id, 'authored')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/folders/${folder}/documents`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const items = res.json().items as Array<{ title: string; myRole: string }>
  assert.equal(items.length, 2)
  assert.equal(items[0]!.title, 'Alpha Draft', 'ordered by lower(title)')
  assert.equal(items[1]!.title, 'Zeta Report')
  assert.ok(items.every((d) => d.myRole === 'owner'))
})

// ============================================================================
// GET /api/v1/documents/:did + /documents/:did/comments
// ============================================================================

test('GET /api/v1/documents/:did — 404, 403, and 200 with myRole', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, outsider.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id, 'authored')

  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${MISSING_UUID}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 404)
  }
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${doc}`,
      headers: authHeaders(outsider.token),
    })
    assert.equal(res.statusCode, 403)
  }
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${doc}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, doc)
    assert.equal(body.kind, 'authored')
    assert.equal(body.currentSnapshotId, null)
    assert.equal(body.myRole, 'owner')
  }
})

test('GET /api/v1/documents/:did/comments — 200 lists comments oldest first', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id, 'authored')

  await seedComment(doc, alice.id, 'Alice', 'first comment')
  // Ensure a strictly later timestamp — the test would race otherwise on
  // fast machines where two INSERTs land in the same microsecond.
  await new Promise((r) => setTimeout(r, 2))
  await seedComment(doc, alice.id, 'Alice', 'second comment')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/comments`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const items = res.json().items as Array<{ body: string }>
  assert.equal(items.length, 2)
  assert.equal(items[0]!.body, 'first comment')
  assert.equal(items[1]!.body, 'second comment')
})

test('GET /api/v1/documents/:did/comments — 403 when caller has no access to the doc', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, outsider.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id, 'authored')
  await seedComment(doc, alice.id, 'Alice', 'secret')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/comments`,
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 403)
})
