import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { provisionAndClaim } from '../src/auth/provisioning.js'
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

async function seedDocument(folderId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO documents (id, folder_id, title, kind, created_by) VALUES ($1, $2, $3, 'authored', $4)",
    [id, folderId, title, createdBy],
  )
  return id
}

async function effectiveRole(userId: string, subjectType: string, subjectId: string): Promise<string | null> {
  const r = await db.query<{ role: string | null }>(
    `SELECT aiper_effective_access($1, $2::aiper_subject, $3) AS role`,
    [userId, subjectType, subjectId],
  )
  return r.rows[0]?.role ?? null
}

async function auditRows(subjectType: string, subjectId: string) {
  const r = await db.query(
    `SELECT action, user_id, old_value, new_value
       FROM audit_log
      WHERE subject_type = $1::aiper_subject AND subject_id = $2
      ORDER BY id ASC`,
    [subjectType, subjectId],
  )
  return r.rows as Array<{ action: string; user_id: string; old_value: unknown; new_value: unknown }>
}

/**
 * Owner-of-a-project fixture used by most cases: Alice creates a project and
 * the aiper_creator_auto_owns trigger makes her its owner. Returns everything
 * a test needs to interact with the project.
 */
async function aliceOwnsAProject(): Promise<{
  alice: SeededUser
  bob: SeededUser
  org: string
  project: string
}> {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  return { alice, bob, org, project }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// Permissions: POST /:sid/permissions
// ============================================================================

test('POST /projects/:pid/permissions — 401 without JWT', async () => {
  const { project, bob } = await aliceOwnsAProject()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/permissions`,
    payload: { userId: bob.id, role: 'viewer' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /projects/:pid/permissions — 403 when caller is not owner (editor is not enough)', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  // Grant Bob 'editor' — still cannot grant to others.
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'user', $2::text, 'editor', $3)`,
    [project, bob.id, alice.id],
  )
  const carol = await seedUser('carol@example.com', 'Carol')
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/permissions`,
    headers: authHeaders(bob.token),
    payload: { userId: carol.id, role: 'viewer' },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /projects/:pid/permissions — 200 grants access, resolver reflects it, audit lands', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  assert.equal(await effectiveRole(bob.id, 'project', project), null, 'Bob starts with no grant')

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/permissions`,
    headers: authHeaders(alice.token),
    payload: { userId: bob.id, role: 'editor' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().role, 'editor')

  assert.equal(await effectiveRole(bob.id, 'project', project), 'editor')
  const audit = await auditRows('project', project)
  const grant = audit.find((r) => r.action === 'permission.granted')
  assert.ok(grant, 'permission.granted audit row written')
  assert.equal((grant!.new_value as { userId: string; role: string }).userId, bob.id)
  assert.equal((grant!.new_value as { userId: string; role: string }).role, 'editor')
})

test('POST /projects/:pid/permissions — upsert flips role and audit oldValue reflects prior', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'user', $2::text, 'viewer', $3)`,
    [project, bob.id, alice.id],
  )
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/permissions`,
    headers: authHeaders(alice.token),
    payload: { userId: bob.id, role: 'owner' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(await effectiveRole(bob.id, 'project', project), 'owner')
  const audit = await auditRows('project', project)
  const grant = audit.find((r) => r.action === 'permission.granted')
  assert.equal((grant!.old_value as { userId: string; role: string }).role, 'viewer')
})

test('POST /projects/:pid/permissions — 409 when demoting the only owner', async () => {
  const { alice, project } = await aliceOwnsAProject()
  // Alice is the sole owner via creator-auto-owns.
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/permissions`,
    headers: authHeaders(alice.token),
    payload: { userId: alice.id, role: 'editor' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'last_owner')
})

test('POST /projects/:pid/permissions — 404 for an unknown target user', async () => {
  const { alice, project } = await aliceOwnsAProject()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/permissions`,
    headers: authHeaders(alice.token),
    payload: { userId: '99999999-9999-9999-9999-999999999999', role: 'viewer' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'user_not_found')
})

// ============================================================================
// Permissions: DELETE /:sid/permissions/:userId
// ============================================================================

test('DELETE /projects/:pid/permissions/:userId — 204 revokes and audit lands', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'user', $2::text, 'editor', $3)`,
    [project, bob.id, alice.id],
  )
  assert.equal(await effectiveRole(bob.id, 'project', project), 'editor')

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${project}/permissions/${bob.id}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 204)
  assert.equal(await effectiveRole(bob.id, 'project', project), null)
  const audit = await auditRows('project', project)
  assert.ok(audit.find((r) => r.action === 'permission.revoked'))
})

test('DELETE /projects/:pid/permissions/:userId — 409 when revoking the last owner', async () => {
  const { alice, project } = await aliceOwnsAProject()
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${project}/permissions/${alice.id}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'last_owner')
  // Grant still there.
  assert.equal(await effectiveRole(alice.id, 'project', project), 'owner')
})

test('DELETE /projects/:pid/permissions/:userId — 204 idempotent when nothing to revoke', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${project}/permissions/${bob.id}`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 204, 'no-op revoke succeeds silently')
})

// ============================================================================
// Invitations
// ============================================================================

test('POST /projects/:pid/invitations — 200 immediate when email matches an existing user', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/invitations`,
    headers: authHeaders(alice.token),
    payload: { email: 'BOB@example.com', role: 'editor' },  // case-insensitive match
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.immediate, true)
  assert.equal(body.email, 'bob@example.com')

  assert.equal(await effectiveRole(bob.id, 'project', project), 'editor')
  const audit = await auditRows('project', project)
  assert.ok(audit.find((r) => r.action === 'permission.granted'))
})

test('POST /projects/:pid/invitations — 200 pending invite when email has no user, converts on first sign-in', async () => {
  const { alice, project } = await aliceOwnsAProject()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/invitations`,
    headers: authHeaders(alice.token),
    payload: { email: 'newcomer@example.com', role: 'editor' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().immediate, false)

  const invite = await db.query<{ role: string }>(
    `SELECT role FROM access_grants
      WHERE subject_type = 'project' AND subject_id = $1
        AND principal_type = 'invite' AND principal_id = 'newcomer@example.com'`,
    [project],
  )
  assert.equal(invite.rows[0]?.role, 'editor', 'invite row stored with lowered email')

  const audit = await auditRows('project', project)
  assert.ok(audit.find((r) => r.action === 'invitation.sent'))

  // Round-trip: the invitee signs in and provisionAndClaim converts the row
  // to principal_type='user'. After that the resolver returns their role.
  const newcomerId = randomUUID()
  await provisionAndClaim(db, {
    id: newcomerId,
    email: 'newcomer@example.com',
    displayName: 'Newcomer',
    avatarUrl: null,
    orgMemberships: [],
  })
  assert.equal(await effectiveRole(newcomerId, 'project', project), 'editor')
})

test('POST /projects/:pid/invitations — 403 for a non-owner', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  // Bob is editor, not owner.
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'user', $2::text, 'editor', $3)`,
    [project, bob.id, alice.id],
  )
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/invitations`,
    headers: authHeaders(bob.token),
    payload: { email: 'newcomer@example.com', role: 'viewer' },
  })
  assert.equal(res.statusCode, 403)
})

test('DELETE /projects/:pid/invitations/:email — 204 removes pending invite + audit', async () => {
  const { alice, project } = await aliceOwnsAProject()
  await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/invitations`,
    headers: authHeaders(alice.token),
    payload: { email: 'newcomer@example.com', role: 'viewer' },
  })

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${project}/invitations/newcomer%40example.com`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 204)

  const remaining = await db.query(
    `SELECT 1 FROM access_grants
      WHERE subject_type = 'project' AND subject_id = $1
        AND principal_type = 'invite' AND principal_id = 'newcomer@example.com'`,
    [project],
  )
  assert.equal(remaining.rowCount, 0)
  const audit = await auditRows('project', project)
  assert.ok(audit.find((r) => r.action === 'invitation.revoked'))
})

// ============================================================================
// Cross-subject spot check — the factory registers all three
// ============================================================================

test('POST /folders/:fid/permissions and /documents/:did/permissions — factory works for all subject types', async () => {
  const { alice, bob, project } = await aliceOwnsAProject()
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id)

  const folderRes = await app.inject({
    method: 'POST',
    url: `/api/v1/folders/${folder}/permissions`,
    headers: authHeaders(alice.token),
    payload: { userId: bob.id, role: 'viewer' },
  })
  assert.equal(folderRes.statusCode, 200)
  assert.equal(await effectiveRole(bob.id, 'folder', folder), 'viewer')

  const docRes = await app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/permissions`,
    headers: authHeaders(alice.token),
    payload: { userId: bob.id, role: 'editor' },
  })
  assert.equal(docRes.statusCode, 200)
  // Bob now has viewer at folder + editor at document — resolver returns
  // the highest of the chain, which for the document should be editor.
  assert.equal(await effectiveRole(bob.id, 'document', doc), 'editor')
})
