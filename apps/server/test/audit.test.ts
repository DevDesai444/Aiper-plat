import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { writeAudit, verifyAuditChain } from '../src/audit.js'
import { setupTestDb, teardownTestDb, truncateAll } from './helpers/testdb.js'

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

// Every audit row needs a valid users.id (FK). Small helper so every case
// starts with a real user without noise.
async function insertUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID()
  const email = `${id}@example.com`
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [
    id,
    email,
    'Test User',
  ])
  return { id, email }
}

// A generic subject_id — audit rows in these tests are not tied to a real
// project/folder/document row (FK constraints are only inside those tables).
function fakeSubjectId(): string {
  return randomUUID()
}

// -------------------------------------------------------------------------- Test 1
test('writeAudit chains rows — prev_hash of row N matches row_hash of row N-1', async () => {
  const user = await insertUser()
  const subj = fakeSubjectId()

  for (const action of ['document.opened', 'document.saved', 'document.saved']) {
    await writeAudit(db, {
      userId: user.id,
      printedName: 'Test User',
      action,
      subjectType: 'document',
      subjectId: subj,
    })
  }

  const rows = await db.query<{ id: number; prev_hash: string | null; row_hash: string }>(
    'SELECT id, prev_hash, row_hash FROM audit_log ORDER BY id ASC',
  )
  assert.equal(rows.rowCount, 3)
  assert.equal(rows.rows[0]!.prev_hash, null, 'first row has no predecessor')
  assert.equal(rows.rows[1]!.prev_hash, rows.rows[0]!.row_hash, 'row 2 chains to row 1')
  assert.equal(rows.rows[2]!.prev_hash, rows.rows[1]!.row_hash, 'row 3 chains to row 2')
})

// -------------------------------------------------------------------------- Test 2
test('verifyAuditChain reports ok:true on a clean three-row chain', async () => {
  const user = await insertUser()
  const subj = fakeSubjectId()
  for (const action of ['a.one', 'a.two', 'a.three']) {
    await writeAudit(db, {
      userId: user.id,
      printedName: 'Test User',
      action,
      subjectType: 'project',
      subjectId: subj,
    })
  }
  const v = await verifyAuditChain(db)
  assert.equal(v.ok, true)
  assert.equal(v.checked, 3)
  assert.equal(v.brokenAtId, null)
})

// -------------------------------------------------------------------------- Test 3
test('verifyAuditChain detects a row whose reason was altered after the fact', async () => {
  const user = await insertUser()
  const subj = fakeSubjectId()
  for (const action of ['a.one', 'a.two', 'a.three']) {
    await writeAudit(db, {
      userId: user.id,
      printedName: 'Test User',
      action,
      subjectType: 'folder',
      subjectId: subj,
      reason: 'original',
    })
  }
  // Tamper: change row 2's reason. The append-only trigger blocks UPDATE
  // via the normal path, so disable it for exactly this superuser-level
  // move — exactly the "an attacker with database access" scenario the
  // chain is meant to detect.
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only')
  try {
    const target = await db.query<{ id: string }>(
      'SELECT id FROM audit_log ORDER BY id ASC OFFSET 1 LIMIT 1',
    )
    await db.query('UPDATE audit_log SET reason = $1 WHERE id = $2', [
      'tampered',
      target.rows[0]!.id,
    ])
    const v = await verifyAuditChain(db)
    assert.equal(v.ok, false)
    // pg returns bigint columns as strings; verifyAuditChain coerces to
    // number, so line up both sides at Number to keep strictEqual happy.
    assert.equal(v.brokenAtId, Number(target.rows[0]!.id))
    assert.match(v.detail, /altered/i)
  } finally {
    await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only')
  }
})

// -------------------------------------------------------------------------- Test 4
test('TRUNCATE audit_log is rejected by the truncate guard', async () => {
  const user = await insertUser()
  await writeAudit(db, {
    userId: user.id,
    printedName: 'Test User',
    action: 'seed',
    subjectType: 'project',
    subjectId: fakeSubjectId(),
  })
  await assert.rejects(
    () => db.query('TRUNCATE TABLE audit_log'),
    /TRUNCATE is not permitted/,
  )
})

// -------------------------------------------------------------------------- Test 5
test('UPDATE on audit_log is rejected by the append-only trigger', async () => {
  const user = await insertUser()
  await writeAudit(db, {
    userId: user.id,
    printedName: 'Test User',
    action: 'seed',
    subjectType: 'project',
    subjectId: fakeSubjectId(),
  })
  await assert.rejects(
    () => db.query(`UPDATE audit_log SET reason = 'nope'`),
    /is not permitted/,
  )
})

// -------------------------------------------------------------------------- Test 6
test('DELETE on audit_log is rejected by the append-only trigger', async () => {
  const user = await insertUser()
  await writeAudit(db, {
    userId: user.id,
    printedName: 'Test User',
    action: 'seed',
    subjectType: 'project',
    subjectId: fakeSubjectId(),
  })
  await assert.rejects(
    () => db.query('DELETE FROM audit_log'),
    /is not permitted/,
  )
})

// ------------------------------------------------------- Test 7 (canonicalization safety)
test('a row whose oldValue has non-alphabetical keys still verifies', async () => {
  // Postgres JSONB reorders keys internally, so read-back may return
  // keys in a different order than the writer sent. canonicalize() on
  // both sides sorts keys before hashing so this is safe.
  const user = await insertUser()
  await writeAudit(db, {
    userId: user.id,
    printedName: 'Test User',
    action: 'document.saved',
    subjectType: 'document',
    subjectId: fakeSubjectId(),
    oldValue: { zebra: 1, apple: 2, banana: { z: 3, a: 4 } },
    newValue: { zebra: 5, apple: 6 },
  })
  const v = await verifyAuditChain(db)
  assert.equal(v.ok, true, v.detail)
  assert.equal(v.checked, 1)
})
