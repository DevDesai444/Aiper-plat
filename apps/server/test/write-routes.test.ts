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

async function seedDocument(folderId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO documents (id, folder_id, title, kind, created_by) VALUES ($1, $2, $3, 'authored', $4)",
    [id, folderId, title, createdBy],
  )
  return id
}

async function grantAccess(
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

async function auditRowsFor(
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
): Promise<Array<{ action: string; user_id: string; new_value: unknown; old_value: unknown }>> {
  const r = await db.query(
    `SELECT action, user_id, new_value, old_value
       FROM audit_log
      WHERE subject_type = $1::aiper_subject AND subject_id = $2
      ORDER BY id ASC`,
    [subjectType, subjectId],
  )
  return r.rows as Array<{ action: string; user_id: string; new_value: unknown; old_value: unknown }>
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// POST /api/v1/orgs
// ============================================================================

test('POST /api/v1/orgs — 401 without JWT', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/orgs',
    payload: { name: 'Acme', slug: 'acme' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /api/v1/orgs — 201 creates org and admin member', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/orgs',
    headers: authHeaders(alice.token),
    payload: { name: 'Acme Satellites', slug: 'acme-satellites' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.slug, 'acme-satellites')

  const admin = await db.query(
    `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [body.id, alice.id],
  )
  assert.equal(admin.rows[0]?.role, 'admin')
})

test('POST /api/v1/orgs — 409 on duplicate slug', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  await seedOrg('Acme')  // slug='acme' already used
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/orgs',
    headers: authHeaders(alice.token),
    payload: { name: 'Acme 2', slug: 'acme' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'duplicate_slug')
})

// ============================================================================
// POST /api/v1/projects
// ============================================================================

test('POST /api/v1/projects — 404 unknown org, 403 non-member, 201 member', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)

  // 404
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(alice.token),
      payload: { orgId: '99999999-9999-9999-9999-999999999999', name: 'X', slug: 'x' },
    })
    assert.equal(res.statusCode, 404)
  }
  // 403 — Bob not a member of the org
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(bob.token),
      payload: { orgId: org, name: 'X', slug: 'x' },
    })
    assert.equal(res.statusCode, 403)
  }
  // 201 — Alice is a member; creator-auto-owns fires; audit row lands
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(alice.token),
      payload: { orgId: org, name: 'MISSION-X', slug: 'mission-x', description: 'Payload thermal' },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.equal(body.myRole, 'owner')
    const audit = await auditRowsFor('project', body.id)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.action, 'project.created')
    assert.equal(audit[0]!.user_id, alice.id)
  }
})

// ============================================================================
// PATCH /api/v1/projects/:pid
// ============================================================================

test('PATCH /api/v1/projects/:pid — 403 for a viewer, 200 for owner with audit', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const viewer = await seedUser('viewer@example.com', 'Viewer')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, viewer.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  await grantAccess('project', project, viewer.id, 'viewer', alice.id)

  // Viewer is blocked — insufficient role, even though they can read.
  {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}`,
      headers: authHeaders(viewer.token),
      payload: { name: 'Should not land' },
    })
    assert.equal(res.statusCode, 403)
  }

  // Alice as owner renames + audit gets old and new values.
  {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}`,
      headers: authHeaders(alice.token),
      payload: { name: 'MISSION-X Rev 2' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().name, 'MISSION-X Rev 2')
    const audit = await auditRowsFor('project', project)
    const rename = audit.find((r) => r.action === 'project.renamed')
    assert.ok(rename, 'project.renamed row was written')
    assert.equal((rename!.old_value as { name: string }).name, 'MISSION-X')
    assert.equal((rename!.new_value as { name: string }).name, 'MISSION-X Rev 2')
  }
})

test('PATCH /api/v1/projects/:pid — no-op body is rejected', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${project}`,
    headers: authHeaders(alice.token),
    payload: {},
  })
  assert.equal(res.statusCode, 400, 'empty PATCH body rejected by Zod refine')
})

// ============================================================================
// POST /api/v1/projects/:pid/folders
// ============================================================================

test('POST /api/v1/projects/:pid/folders — 201 creates root folder + audit', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/folders`,
    headers: authHeaders(alice.token),
    payload: { name: 'TCS' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.name, 'TCS')
  assert.equal(body.parentFolderId, null)
  assert.equal(body.myRole, 'owner')

  const audit = await auditRowsFor('folder', body.id)
  assert.equal(audit.length, 1)
  assert.equal(audit[0]!.action, 'folder.created')
})

test('POST /api/v1/projects/:pid/folders — 404 for a parent from another project', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const proj1 = await seedProject(org, 'Proj 1', alice.id)
  const proj2 = await seedProject(org, 'Proj 2', alice.id)
  const folderInProj2 = await seedFolder(proj2, null, 'TCS', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${proj1}/folders`,
    headers: authHeaders(alice.token),
    payload: { parentFolderId: folderInProj2, name: 'Sub' },
  })
  assert.equal(res.statusCode, 404, 'parent in a different project rejected')
})

// ============================================================================
// PATCH /api/v1/folders/:fid
// ============================================================================

test('PATCH /api/v1/folders/:fid — 200 renames with audit', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/folders/${folder}`,
    headers: authHeaders(alice.token),
    payload: { name: 'Thermal Control' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().name, 'Thermal Control')
  const audit = await auditRowsFor('folder', folder)
  const rename = audit.find((r) => r.action === 'folder.renamed')
  assert.ok(rename, 'folder.renamed row was written')
})

test('PATCH /api/v1/folders/:fid — 400 when moving across projects', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const proj1 = await seedProject(org, 'Proj 1', alice.id)
  const proj2 = await seedProject(org, 'Proj 2', alice.id)
  const folderInProj1 = await seedFolder(proj1, null, 'TCS', alice.id)
  const folderInProj2 = await seedFolder(proj2, null, 'ADCS', alice.id)

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/folders/${folderInProj1}`,
    headers: authHeaders(alice.token),
    payload: { parentFolderId: folderInProj2 },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'cross_project_move')
})

// ============================================================================
// POST /api/v1/folders/:fid/documents + PATCH /api/v1/documents/:did
// ============================================================================

test('POST /api/v1/folders/:fid/documents — 201 creates authored doc + audit', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/folders/${folder}/documents`,
    headers: authHeaders(alice.token),
    payload: { title: 'TVAC Report', kind: 'authored' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.title, 'TVAC Report')
  assert.equal(body.kind, 'authored')
  assert.equal(body.currentSnapshotId, null)
  assert.equal(body.myRole, 'owner')

  const audit = await auditRowsFor('document', body.id)
  assert.equal(audit.length, 1)
  assert.equal(audit[0]!.action, 'document.created')
})

test('POST /api/v1/folders/:fid/documents — 400 for kind != authored', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/folders/${folder}/documents`,
    headers: authHeaders(alice.token),
    payload: { title: 'Sheet', kind: 'technical-sheet' },
  })
  assert.equal(res.statusCode, 400, 'Zod literal("authored") rejects other kinds')
})

test('PATCH /api/v1/documents/:did — 200 renames with audit', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, null, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'Draft 1', alice.id)

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/documents/${doc}`,
    headers: authHeaders(alice.token),
    payload: { title: 'Draft 2' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().title, 'Draft 2')
  const audit = await auditRowsFor('document', doc)
  const rename = audit.find((r) => r.action === 'document.renamed')
  assert.ok(rename)
})
