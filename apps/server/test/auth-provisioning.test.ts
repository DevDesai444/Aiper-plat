import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type pg from 'pg'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { provisionAndClaim, fetchOrgMemberships } from '../src/auth/provisioning.js'
import { setupTestDb, teardownTestDb, truncateAll, testDbConfig } from './helpers/testdb.js'

const SECRET = 'test-secret-plenty-long-enough-for-hs256'
const ISSUER = 'https://test-project.supabase.co/auth/v1'

let db: pg.Pool
before(async () => {
  db = await setupTestDb()
})
after(async () => {
  await teardownTestDb(db)
})
beforeEach(async () => {
  await truncateAll(db)
})

function buildConfig(): Config {
  const t = testDbConfig()
  return {
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
}

async function signToken(sub: string, email: string, meta: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub,
    email,
    user_metadata: meta,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

// -------------------------------------------------------------------------- Test 1
test('first-seen JWT inserts a users row with sub, email, display_name', async () => {
  const sub = randomUUID()
  await provisionAndClaim(db, {
    id: sub,
    email: 'p1@example.com',
    displayName: 'P1',
    avatarUrl: null,
    orgMemberships: [],
  })
  const r = await db.query<{ id: string; email: string; display_name: string }>(
    'SELECT id, email, display_name FROM users WHERE id = $1',
    [sub],
  )
  assert.equal(r.rowCount, 1)
  assert.equal(r.rows[0]!.email, 'p1@example.com')
  assert.equal(r.rows[0]!.display_name, 'P1')
})

// -------------------------------------------------------------------------- Test 2
test('second-seen JWT with the same sub updates display_name in place (no duplicate)', async () => {
  const sub = randomUUID()
  await provisionAndClaim(db, {
    id: sub,
    email: 'p1@example.com',
    displayName: 'P1',
    avatarUrl: null,
    orgMemberships: [],
  })
  await provisionAndClaim(db, {
    id: sub,
    email: 'p1@example.com',
    displayName: 'P1 Renamed',
    avatarUrl: 'https://example.com/a.png',
    orgMemberships: [],
  })
  const r = await db.query<{ display_name: string; avatar_url: string | null }>(
    'SELECT display_name, avatar_url FROM users WHERE id = $1',
    [sub],
  )
  assert.equal(r.rowCount, 1, 'no duplicate row')
  assert.equal(r.rows[0]!.display_name, 'P1 Renamed')
  assert.equal(r.rows[0]!.avatar_url, 'https://example.com/a.png')
})

// -------------------------------------------------------------------------- Test 3
test('pending invitations for this email are claimed as user grants on first sign-in', async () => {
  // Seed: an inviter owns Project1 and invites p2@example.com as editor.
  const inviter = randomUUID()
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    inviter,
    'inviter@example.com',
    'Inviter',
  ])
  const org = randomUUID()
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    org,
    'Acme',
    'acme',
  ])
  const project = randomUUID()
  await db.query(
    `INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [project, org, 'Project1', 'project-1', inviter],
  )
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'invite', $2, 'editor', $3)`,
    [project, 'p2@example.com', inviter],
  )

  // Now P2 signs in with matching email.
  const p2 = randomUUID()
  await provisionAndClaim(db, {
    id: p2,
    email: 'p2@example.com',
    displayName: 'P2',
    avatarUrl: null,
    orgMemberships: [],
  })

  const r = await db.query<{ principal_type: string; principal_id: string; role: string }>(
    'SELECT principal_type, principal_id, role FROM access_grants WHERE subject_id = $1',
    [project],
  )
  // Two grants on the project — the creator (owner) and the newly-claimed one for P2.
  assert.equal(r.rowCount, 2)
  const claimed = r.rows.find((g) => g.role === 'editor')
  assert.ok(claimed, 'the invite-editor grant was preserved')
  assert.equal(claimed!.principal_type, 'user', 'invite converted to user grant')
  assert.equal(claimed!.principal_id, p2, 'principal_id now names the user id')
})

// -------------------------------------------------------------------------- Test 4
test('invite claim matches case-insensitively on email', async () => {
  const inviter = randomUUID()
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    inviter,
    'inviter@example.com',
    'Inviter',
  ])
  const org = randomUUID()
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    org,
    'Acme',
    'acme',
  ])
  const project = randomUUID()
  await db.query(
    `INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [project, org, 'P', 'p', inviter],
  )
  // Invite stored in mixed case; JWT arrives in all-lowercase.
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'invite', $2, 'viewer', $3)`,
    [project, 'Alex.Kim@Example.COM', inviter],
  )

  const alex = randomUUID()
  await provisionAndClaim(db, {
    id: alex,
    email: 'alex.kim@example.com',
    displayName: 'Alex Kim',
    avatarUrl: null,
    orgMemberships: [],
  })

  const claimed = await db.query<{ principal_type: string; role: string }>(
    "SELECT principal_type, role FROM access_grants WHERE subject_id = $1 AND role = 'viewer'",
    [project],
  )
  assert.equal(claimed.rowCount, 1)
  assert.equal(claimed.rows[0]!.principal_type, 'user')
})

// -------------------------------------------------------------------------- Test 5
test('invites addressed to a different email are not touched', async () => {
  const inviter = randomUUID()
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    inviter,
    'inviter@example.com',
    'Inviter',
  ])
  const org = randomUUID()
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    org,
    'Acme',
    'acme',
  ])
  const project = randomUUID()
  await db.query(
    `INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [project, org, 'P', 'p', inviter],
  )
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ('project', $1, 'invite', 'foo@example.com', 'editor', $2)`,
    [project, inviter],
  )

  // bar@example.com signs in — foo's invite must stay put.
  const bar = randomUUID()
  await provisionAndClaim(db, {
    id: bar,
    email: 'bar@example.com',
    displayName: 'Bar',
    avatarUrl: null,
    orgMemberships: [],
  })

  const foo = await db.query<{ principal_type: string; principal_id: string }>(
    "SELECT principal_type, principal_id FROM access_grants WHERE role = 'editor' AND subject_id = $1",
    [project],
  )
  assert.equal(foo.rowCount, 1)
  assert.equal(foo.rows[0]!.principal_type, 'invite', 'foo invite is still an invite')
  assert.equal(foo.rows[0]!.principal_id, 'foo@example.com')
})

// -------------------------------------------------------------------------- Test 6
test('fetchOrgMemberships returns the caller\'s memberships', async () => {
  const user = randomUUID()
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    user,
    'u@example.com',
    'U',
  ])
  const orgA = randomUUID()
  const orgB = randomUUID()
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)', [
    orgA,
    'Alpha',
    'alpha',
    orgB,
    'Beta',
    'beta',
  ])
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $3, 'admin'), ($2, $3, 'member')`,
    [orgA, orgB, user],
  )
  const memberships = await fetchOrgMemberships(db, user)
  const byOrg = new Map(memberships.map((m) => [m.orgId, m.role]))
  assert.equal(byOrg.get(orgA), 'admin')
  assert.equal(byOrg.get(orgB), 'member')
  assert.equal(memberships.length, 2)
})

// -------------------------------------------------------------------------- Test 7 (integration)
test('GET /api/v1/me returns real orgMemberships after DB provisioning', async () => {
  const sub = randomUUID()
  const app = await buildServer(buildConfig(), db)
  try {
    // Seed the org + membership BEFORE the JWT arrives — the middleware
    // provisions the user, then reads memberships.
    // Users row will be created by the middleware on the fly, so seed
    // the org rows without needing the user yet.
    const org = randomUUID()
    await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      org,
      'Aiper Test Org',
      'aiper-test-org',
    ])
    // But org_members needs the user_id — the middleware creates the
    // user row inside its own preHandler. So we tell it about the user
    // first (matching what the JWT sub will be), then add membership.
    await db.query(
      'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [sub, 'p1@example.com', 'P1'],
    )
    await db.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')",
      [org, sub],
    )

    const token = await signToken(sub, 'p1@example.com', { name: 'P1' })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, sub)
    assert.equal(body.orgMemberships.length, 1)
    assert.equal(body.orgMemberships[0]?.orgId, org)
    assert.equal(body.orgMemberships[0]?.role, 'member')
  } finally {
    await app.close()
  }
})
