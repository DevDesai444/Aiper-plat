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

async function seedPendingInvite(
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
  email: string,
  role: 'viewer' | 'editor' | 'owner',
  invitedBy: string,
): Promise<void> {
  await db.query(
    `INSERT INTO access_grants
       (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ($1::aiper_subject, $2, 'invite', $3, $4::aiper_role, $5)`,
    [subjectType, subjectId, email.toLowerCase(), role, invitedBy],
  )
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ============================================================================
// GET /:sid/members
// ============================================================================

test('GET /projects/:pid/members — 401 without JWT', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)

  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/members` })
  assert.equal(res.statusCode, 401)
})

test('GET /projects/:pid/members — 403 when caller has no access', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, outsider.id)  // outsider is in org but has no grant on the project
  const project = await seedProject(org, 'MISSION-X', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/members`,
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 403)
})

test('GET /projects/:pid/members — 200 with only direct members (viewer-visible)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const carol = await seedUser('carol@example.com', 'Carol')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  await joinOrg(org, carol.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)  // Alice = owner via trigger
  await grantDirect('project', project, bob.id, 'editor', alice.id)
  // Carol is an org member but has no grant on the project — should be omitted.

  // Any of the three grantees can read (viewer+). Alice reads.
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/members`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const members = res.json().members as Array<{
    userId: string
    role: string
    inherited: boolean
    displayName: string
  }>
  assert.equal(members.length, 2)
  const byId = new Map(members.map((m) => [m.userId, m]))
  assert.equal(byId.get(alice.id)?.role, 'owner')
  assert.equal(byId.get(alice.id)?.inherited, false, 'creator grant is direct')
  assert.equal(byId.get(bob.id)?.role, 'editor')
  assert.equal(byId.get(bob.id)?.inherited, false, 'direct grant is not inherited')
  assert.equal(byId.has(carol.id), false, 'org member without a grant is omitted')
})

test('GET /folders/:fid/members — inherited flag when grant is on the project', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)  // Alice direct-owns both
  // Bob gets a viewer grant on the PROJECT, none on the folder — the
  // folder members list should mark him as inherited=true.
  await grantDirect('project', project, bob.id, 'viewer', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/folders/${folder}/members`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const members = res.json().members as Array<{ userId: string; role: string; inherited: boolean }>
  const bobEntry = members.find((m) => m.userId === bob.id)
  assert.ok(bobEntry, "Bob shows up on the folder's member list")
  assert.equal(bobEntry!.role, 'viewer')
  assert.equal(bobEntry!.inherited, true, "reached the folder only via the project grant")

  const aliceEntry = members.find((m) => m.userId === alice.id)
  assert.equal(aliceEntry!.inherited, false, 'Alice has a direct grant from creator-auto-owns')
})

test('GET /projects/:pid/members — a direct grant overrides an ancestor grant (inherited=false)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)

  // Bob has BOTH a project grant AND a folder grant. On the folder, the
  // direct row wins → inherited=false.
  await grantDirect('project', project, bob.id, 'viewer', alice.id)
  await grantDirect('folder',  folder,  bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/folders/${folder}/members`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const bobEntry = (res.json().members as Array<{ userId: string; role: string; inherited: boolean }>)
    .find((m) => m.userId === bob.id)!
  assert.equal(bobEntry.role, 'editor', 'highest-wins resolver picks editor')
  assert.equal(bobEntry.inherited, false, 'direct folder grant overrides inherited flag')
})

// ============================================================================
// GET /:sid/invitations (pending)
// ============================================================================

test('GET /projects/:pid/invitations — 403 for editor (owner-only)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const bob = await seedUser('bob@example.com', 'Bob')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  await joinOrg(org, bob.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  await grantDirect('project', project, bob.id, 'editor', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/invitations`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 403, 'editor cannot list pending invites')
})

test('GET /projects/:pid/invitations — 200 lists unclaimed invites for the owner', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)

  await seedPendingInvite('project', project, 'newcomer@example.com', 'editor', alice.id)
  await seedPendingInvite('project', project, 'another@example.com',  'viewer', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/invitations`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const invitations = res.json().invitations as Array<{ email: string; role: string; invitedAt: string }>
  assert.equal(invitations.length, 2)
  assert.equal(invitations[0]!.email, 'another@example.com', 'ordered by email ascending')
  assert.equal(invitations[1]!.email, 'newcomer@example.com')
  assert.equal(invitations[1]!.role, 'editor')
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(invitations[0]!.invitedAt), 'invitedAt is ISO 8601')
})

// ============================================================================
// Cross-subject spot check
// ============================================================================

test('GET /documents/:did/members and /invitations — factory works for documents', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme')
  await joinOrg(org, alice.id)
  const project = await seedProject(org, 'MISSION-X', alice.id)
  const folder = await seedFolder(project, 'TCS', alice.id)
  const docId = randomUUID()
  await db.query(
    "INSERT INTO documents (id, folder_id, title, kind, created_by) VALUES ($1, $2, 'D', 'authored', $3)",
    [docId, folder, alice.id],
  )
  await seedPendingInvite('document', docId, 'reviewer@example.com', 'viewer', alice.id)

  const members = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${docId}/members`,
    headers: authHeaders(alice.token),
  })
  assert.equal(members.statusCode, 200)
  const memberRows = members.json().members as Array<{ userId: string; role: string }>
  assert.equal(memberRows.find((m) => m.userId === alice.id)?.role, 'owner')

  const invites = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${docId}/invitations`,
    headers: authHeaders(alice.token),
  })
  assert.equal(invites.statusCode, 200)
  const inviteRows = invites.json().invitations as Array<{ email: string; role: string }>
  assert.equal(inviteRows.length, 1)
  assert.equal(inviteRows[0]!.email, 'reviewer@example.com')
})
