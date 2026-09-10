import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type pg from 'pg'
import { buildServer } from '../src/server.js'
import { writeAudit, encodeCursor, decodeCursor } from '../src/audit.js'
import type { Config } from '../src/config.js'
import type { AuditPage } from '@aiper/shared/types'
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
  }
}

async function signToken(sub: string, email: string): Promise<string> {
  return new SignJWT({ sub, email, user_metadata: { name: email } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

async function insertUser(email = `${randomUUID()}@example.com`): Promise<string> {
  const id = randomUUID()
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    id,
    email,
    'Test User',
  ])
  return id
}

async function insertOrg(): Promise<string> {
  const id = randomUUID()
  const slug = `org-${id.slice(0, 8)}`
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    id,
    'Org',
    slug,
  ])
  return id
}

async function insertProject(orgId: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  const slug = `p-${id.slice(0, 8)}`
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, orgId, 'Proj', slug, createdBy],
  )
  return id
}

async function grant(
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
  userId: string,
  role: 'viewer' | 'editor' | 'owner',
  grantedBy: string,
): Promise<void> {
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ($1, $2, 'user', $3, $4, $5)
     ON CONFLICT (subject_type, subject_id, principal_type, principal_id)
       DO UPDATE SET role = EXCLUDED.role`,
    [subjectType, subjectId, userId, role, grantedBy],
  )
}

async function callAudit(app: Awaited<ReturnType<typeof buildServer>>, token: string, query = ''): Promise<{ status: number; body: AuditPage | { error: string } }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/audit${query ? '?' + query : ''}`,
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.statusCode, body: res.json() as AuditPage | { error: string } }
}

// ---------------------------------------------------------------------- tests

test('empty list returns { entries: [], nextCursor: null }', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const user = await insertUser('caller@example.com')
    const token = await signToken(user, 'caller@example.com')
    const { status, body } = await callAudit(app, token)
    assert.equal(status, 200)
    assert.deepEqual((body as AuditPage).entries, [])
    assert.equal((body as AuditPage).nextCursor, null)
  } finally {
    await app.close()
  }
})

test('caller sees their own audit entries by default (no subject filter)', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const caller = await insertUser('caller@example.com')
    const stranger = await insertUser('stranger@example.com')
    const org = await insertOrg()
    const project = await insertProject(org, stranger)

    // Caller's own action
    await writeAudit(db, {
      userId: caller,
      printedName: 'Caller',
      action: 'auth.login',
      subjectType: 'project',
      subjectId: project,
    })
    // Stranger's action on a project the caller has no access to
    await writeAudit(db, {
      userId: stranger,
      printedName: 'Stranger',
      action: 'project.created',
      subjectType: 'project',
      subjectId: project,
    })

    const token = await signToken(caller, 'caller@example.com')
    const { status, body } = await callAudit(app, token)
    assert.equal(status, 200)
    const page = body as AuditPage
    assert.equal(page.entries.length, 1)
    assert.equal(page.entries[0]?.action, 'auth.login')
    assert.equal(page.entries[0]?.userId, caller)
  } finally {
    await app.close()
  }
})

test('caller sees entries on any subject they can reach via the resolver', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const caller = await insertUser('caller@example.com')
    const stranger = await insertUser('stranger@example.com')
    const org = await insertOrg()
    const project = await insertProject(org, stranger)
    // Grant caller viewer on the project.
    await grant('project', project, caller, 'viewer', stranger)

    // Stranger's action on the project — caller should see it.
    await writeAudit(db, {
      userId: stranger,
      printedName: 'Stranger',
      action: 'document.saved',
      subjectType: 'project',
      subjectId: project,
    })

    const token = await signToken(caller, 'caller@example.com')
    const { status, body } = await callAudit(app, token)
    assert.equal(status, 200)
    assert.equal((body as AuditPage).entries.length, 1)
  } finally {
    await app.close()
  }
})

test('subject filter with viewer access returns entries scoped to that subject', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const caller = await insertUser('caller@example.com')
    const stranger = await insertUser('stranger@example.com')
    const org = await insertOrg()
    const p1 = await insertProject(org, stranger)
    const p2 = await insertProject(org, stranger)
    await grant('project', p1, caller, 'viewer', stranger)

    // One entry per project — filter should return only p1's.
    await writeAudit(db, {
      userId: stranger,
      printedName: 'Stranger',
      action: 'x',
      subjectType: 'project',
      subjectId: p1,
    })
    await writeAudit(db, {
      userId: stranger,
      printedName: 'Stranger',
      action: 'y',
      subjectType: 'project',
      subjectId: p2,
    })

    const token = await signToken(caller, 'caller@example.com')
    const { status, body } = await callAudit(app, token, `subjectType=project&subjectId=${p1}`)
    assert.equal(status, 200)
    const page = body as AuditPage
    assert.equal(page.entries.length, 1)
    assert.equal(page.entries[0]?.action, 'x')
  } finally {
    await app.close()
  }
})

test('subject filter returns 403 when the caller has no access to that subject', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const caller = await insertUser('caller@example.com')
    const stranger = await insertUser('stranger@example.com')
    const org = await insertOrg()
    const project = await insertProject(org, stranger)
    // Caller has no grant here.

    const token = await signToken(caller, 'caller@example.com')
    const { status, body } = await callAudit(app, token, `subjectType=project&subjectId=${project}`)
    assert.equal(status, 403)
    const errBody = body as { code?: string; error?: string }
    assert.equal(errBody.code, 'no_access')
  } finally {
    await app.close()
  }
})

test('pagination: 60 rows return in a 50-row page + cursor, then a 10-row page + null', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const caller = await insertUser('caller@example.com')
    const org = await insertOrg()
    const project = await insertProject(org, caller)  // caller auto-owns

    for (let i = 0; i < 60; i++) {
      await writeAudit(db, {
        userId: caller,
        printedName: 'Caller',
        action: `evt.${i}`,
        subjectType: 'project',
        subjectId: project,
      })
    }

    const token = await signToken(caller, 'caller@example.com')

    const first = await callAudit(app, token, `subjectType=project&subjectId=${project}`)
    assert.equal(first.status, 200)
    const firstPage = first.body as AuditPage
    assert.equal(firstPage.entries.length, 50)
    assert.notEqual(firstPage.nextCursor, null)

    const second = await callAudit(
      app,
      token,
      `subjectType=project&subjectId=${project}&cursor=${firstPage.nextCursor}`,
    )
    assert.equal(second.status, 200)
    const secondPage = second.body as AuditPage
    assert.equal(secondPage.entries.length, 10)
    assert.equal(secondPage.nextCursor, null)

    // No entry appears twice across the two pages.
    const idsSeen = new Set([...firstPage.entries, ...secondPage.entries].map((e) => e.id))
    assert.equal(idsSeen.size, 60)
  } finally {
    await app.close()
  }
})

test('cursor is stable under concurrent inserts (id-DESC keyset)', async () => {
  const app = await buildServer(buildConfig(), db)
  try {
    const caller = await insertUser('caller@example.com')
    const org = await insertOrg()
    const project = await insertProject(org, caller)

    // Seed 60 rows, fetch first page.
    for (let i = 0; i < 60; i++) {
      await writeAudit(db, {
        userId: caller,
        printedName: 'Caller',
        action: `evt.${i}`,
        subjectType: 'project',
        subjectId: project,
      })
    }
    const token = await signToken(caller, 'caller@example.com')
    const first = await callAudit(app, token, `subjectType=project&subjectId=${project}`)
    const firstPage = first.body as AuditPage
    const firstIds = firstPage.entries.map((e) => e.id)

    // Now write 5 more rows between page fetches — these are newer than
    // the cursor point, so they must land on the PREVIOUS page (which
    // the caller already saw), NOT interleave into the next page.
    for (let i = 0; i < 5; i++) {
      await writeAudit(db, {
        userId: caller,
        printedName: 'Caller',
        action: `late.${i}`,
        subjectType: 'project',
        subjectId: project,
      })
    }

    const second = await callAudit(
      app,
      token,
      `subjectType=project&subjectId=${project}&cursor=${firstPage.nextCursor}`,
    )
    const secondPage = second.body as AuditPage
    const secondIds = secondPage.entries.map((e) => e.id)

    // Ids from page 2 must all be smaller than the smallest id from page 1.
    // (Keyset pagination on id DESC guarantees this — no duplicates, no
    // interleaving.)
    const minFirst = Math.min(...firstIds)
    for (const id of secondIds) {
      assert.ok(id < minFirst, `id ${id} on page 2 should be less than page 1 min ${minFirst}`)
    }
  } finally {
    await app.close()
  }
})

test('encodeCursor / decodeCursor round-trip', () => {
  assert.equal(decodeCursor(encodeCursor(42)), 42)
  assert.equal(decodeCursor('not-a-real-cursor'), null)
})
