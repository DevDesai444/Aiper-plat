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

async function seedDocInProject(projectId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO documents (id, project_id, title, kind, created_by) VALUES ($1, $2, $3, 'authored', $4)",
    [id, projectId, title, createdBy],
  )
  return id
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// GET /api/v1/search
// ============================================================================

test('GET /search — 401 without JWT', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=anything' })
  assert.equal(res.statusCode, 401)
})

test('GET /search — case-insensitive substring, returns project + folder context', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc1 = await seedDocInFolder(folder, 'TVAC Report Rev 2', alice.id)
  await seedDocInFolder(folder, 'Structural memo', alice.id)   // no "tvac"
  const doc2 = await seedDocInProject(project, 'TVAC follow-up', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=tvac',                              // lowercase q
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const results = res.json().results as Array<{
    document: { id: string; title: string }
    project: { id: string; name: string }
    folder: { id: string; name: string } | null
    myRole: string
  }>
  assert.equal(results.length, 2)
  const byId = new Map(results.map((r) => [r.document.id, r]))
  assert.equal(byId.get(doc1)?.folder?.name, 'TCS', 'folder-parented doc carries folder context')
  assert.equal(byId.get(doc1)?.project.id, project)
  assert.equal(byId.get(doc2)?.folder, null, 'project-parented doc has folder: null')
  assert.equal(byId.get(doc2)?.project.id, project)
  assert.ok(results.every((r) => r.myRole === 'owner'), 'creator has owner via auto-owns')
})

test('GET /search — result order is by lower(title) ascending', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  await seedDocInFolder(folder, 'zebra report', alice.id)
  await seedDocInFolder(folder, 'Alpha report', alice.id)
  await seedDocInFolder(folder, 'middle report', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=report',
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const titles = (res.json().results as Array<{ document: { title: string } }>).map(
    (r) => r.document.title,
  )
  assert.deepEqual(titles, ['Alpha report', 'middle report', 'zebra report'])
})

test('GET /search — access filter omits documents the caller cannot see', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, outsider.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  await seedDocInFolder(folder, 'Secret TVAC Report', alice.id)  // outsider has no grant

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=tvac',
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().results.length, 0, 'a doc without an access grant is absent, not 403')
})

test('GET /search — respects the limit param', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  for (let i = 1; i <= 5; i++) await seedDocInFolder(folder, `TVAC ${i}`, alice.id)

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=tvac&limit=3',
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().results.length, 3, 'result count capped at limit')
})

test('GET /search — LIKE wildcards in q are escaped (percent stays literal)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  await seedDocInFolder(folder, 'Margin is 50%',    alice.id)  // matches "50%"
  await seedDocInFolder(folder, '50 things to do',  alice.id)  // would match "50%" as wildcard

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=50%25',                            // %25 = URL-encoded '%'
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const titles = (res.json().results as Array<{ document: { title: string } }>)
    .map((r) => r.document.title)
  assert.deepEqual(titles, ['Margin is 50%'], 'literal "50%" match; unescaped "50 things" is not returned')
})

// ============================================================================
// GET /api/v1/projects/:pid/search
// ============================================================================

test('GET /projects/:pid/search — scopes to one project; other projects absent', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const p1 = await seedProject(org, 'Proj 1', alice.id)
  const p2 = await seedProject(org, 'Proj 2', alice.id)
  const f1 = await seedFolder(p1, 'TCS', alice.id)
  const f2 = await seedFolder(p2, 'TCS', alice.id)
  const inP1 = await seedDocInFolder(f1, 'TVAC 1', alice.id)
  const inP2 = await seedDocInFolder(f2, 'TVAC 2', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${p1}/search?q=tvac`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const ids = (res.json().results as Array<{ document: { id: string } }>).map((r) => r.document.id)
  assert.deepEqual(ids, [inP1], 'project-scoped result omits docs in other projects')
  assert.ok(!ids.includes(inP2))
})

test('GET /projects/:pid/search — 404 for unknown project', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/99999999-9999-9999-9999-999999999999/search?q=x',
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
})
