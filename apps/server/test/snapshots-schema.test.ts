/**
 * Verifies migration 008 (E3's document_snapshots + the reverse FK that
 * closes documents.current_snapshot_id).
 *
 * Pattern mirrors apps/server/test/hierarchy-schema.test.ts as landed in
 * E2's PR-6 (commit b381c9f): module-scope `let db: pg.Pool`,
 * `before/after` around setupTestDb / teardownTestDb, `beforeEach`
 * truncate. Inline fixture helpers are duplicated from that file — a
 * shared fixtures module is a follow-up once a third schema test file
 * needs them.
 */

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
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

// ------------------------------------------------------------ fixture helpers

async function insertUser(email: string, displayName: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    [id, email, displayName],
  )
  return id
}

async function insertOrg(name: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)',
    [id, name, name.toLowerCase().replace(/\s+/g, '-')],
  )
  return id
}

async function insertProject(orgId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO projects (id, org_id, name, slug, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, orgId, name, name.toLowerCase().replace(/\s+/g, '-'), null, createdBy],
  )
  return id
}

async function insertFolder(projectId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO folders (id, project_id, parent_folder_id, name, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
    [id, projectId, null, name, createdBy],
  )
  return id
}

async function insertDocument(folderId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, $3, 'authored', $4)`,
    [id, folderId, title, createdBy],
  )
  return id
}

/** Insert one document_snapshot row and return its id. `yjsState` defaults
 *  to a tiny non-empty buffer so the NOT NULL BYTEA check is exercised
 *  without every caller supplying one. */
async function insertSnapshot(
  documentId: string,
  savedBy: string,
  reason: 'auto' | 'checkpoint' | 'release',
  label: string | null,
  yjsState: Buffer = Buffer.from([1, 2, 3, 4]),
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO document_snapshots
       (id, document_id, yjs_state, reason, label, saved_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, documentId, yjsState, reason, label, savedBy],
  )
  return id
}

// -------------------------------------------------------------------- tests

test('snapshot INSERT round-trips every column, saved_at defaults to now()', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)

  const snap = await insertSnapshot(doc, alex, 'checkpoint', 'Baseline v1')

  const row = await db.query<{
    id: string
    document_id: string
    yjs_state: Buffer
    reason: string
    label: string | null
    saved_by: string
    saved_at: Date
  }>(
    `SELECT id, document_id, yjs_state, reason, label, saved_by, saved_at
       FROM document_snapshots WHERE id = $1`,
    [snap],
  )
  assert.equal(row.rows[0]?.document_id, doc)
  assert.equal(row.rows[0]?.reason, 'checkpoint')
  assert.equal(row.rows[0]?.label, 'Baseline v1')
  assert.equal(row.rows[0]?.saved_by, alex)
  assert.ok(row.rows[0]?.saved_at instanceof Date, 'saved_at defaults to now()')
  assert.ok(Buffer.isBuffer(row.rows[0]?.yjs_state))
  assert.equal(row.rows[0]?.yjs_state.length, 4)
})

test('snapshot reason CHECK rejects a value outside the enum', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)

  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO document_snapshots
           (id, document_id, yjs_state, reason, label, saved_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), doc, Buffer.from([0]), 'manual', null, alex],
      ),
    /document_snapshots_reason_check/,
  )
})

test('yjs_state NOT NULL is enforced', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)

  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO document_snapshots
           (id, document_id, yjs_state, reason, label, saved_by)
         VALUES ($1, $2, NULL, 'checkpoint', NULL, $3)`,
        [randomUUID(), doc, alex],
      ),
    /null value in column "yjs_state"/,
  )
})

test('document_id FK rejects a snapshot pointing at a non-existent document', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')

  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO document_snapshots
           (id, document_id, yjs_state, reason, label, saved_by)
         VALUES ($1, $2, $3, 'auto', NULL, $4)`,
        [randomUUID(), randomUUID(), Buffer.from([0]), alex],
      ),
    /violates foreign key constraint/,
  )
})

test('deleting the parent document CASCADEs to its snapshots', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)

  await insertSnapshot(doc, alex, 'auto', null)
  await insertSnapshot(doc, alex, 'checkpoint', 'v1')

  const before = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_snapshots WHERE document_id = $1`,
    [doc],
  )
  assert.equal(before.rows[0]?.n, '2')

  await db.query(`DELETE FROM documents WHERE id = $1`, [doc])

  const after = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_snapshots`,
  )
  assert.equal(after.rows[0]?.n, '0')
})

test('documents.current_snapshot_id FK accepts a valid snapshot id', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)
  const snap = await insertSnapshot(doc, alex, 'checkpoint', 'v1')

  await db.query(`UPDATE documents SET current_snapshot_id = $1 WHERE id = $2`, [snap, doc])

  const row = await db.query<{ current_snapshot_id: string | null }>(
    `SELECT current_snapshot_id FROM documents WHERE id = $1`,
    [doc],
  )
  assert.equal(row.rows[0]?.current_snapshot_id, snap)
})

test('documents.current_snapshot_id FK rejects a bogus snapshot id', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)

  await assert.rejects(
    () =>
      db.query(`UPDATE documents SET current_snapshot_id = $1 WHERE id = $2`, [
        randomUUID(),
        doc,
      ]),
    /documents_current_snapshot_fk/,
  )
})

test('deleting a snapshot pointed to by documents.current_snapshot_id sets it NULL', async () => {
  // The reverse FK is ON DELETE SET NULL — deleting a snapshot leaves the
  // document's pointer cleared rather than blocking the delete or dangling.
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex)
  const snap = await insertSnapshot(doc, alex, 'checkpoint', 'v1')
  await db.query(`UPDATE documents SET current_snapshot_id = $1 WHERE id = $2`, [snap, doc])

  await db.query(`DELETE FROM document_snapshots WHERE id = $1`, [snap])

  const row = await db.query<{ current_snapshot_id: string | null }>(
    `SELECT current_snapshot_id FROM documents WHERE id = $1`,
    [doc],
  )
  assert.equal(row.rows[0]?.current_snapshot_id, null)
})

test('saved_at DESC index exists for the timeline scan', async () => {
  // Sanity check the read path. The Save timeline pulls by document_id +
  // ORDER BY saved_at DESC; the migration must ship the matching index.
  const idx = await db.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'document_snapshots' AND indexname = 'document_snapshots_doc_saved_idx'`,
  )
  assert.equal(idx.rowCount, 1, 'document_snapshots_doc_saved_idx should exist')
  assert.match(idx.rows[0]!.indexdef, /document_id/)
  assert.match(idx.rows[0]!.indexdef, /saved_at DESC/)
})
