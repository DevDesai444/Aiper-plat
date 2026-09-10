/**
 * DRAFT — for apps/server/test/hierarchy-schema.test.ts.
 *
 * Verifies migration 006 (E2's domain-column ALTERs on projects / folders /
 * documents + the folder self-parent CHECK) and 007 (comments), plus that
 * E1's aiper_creator_auto_owns trigger from 004 still fires end-to-end with
 * our added columns attached.
 *
 * Pattern mirrors apps/server/test/access-resolver.test.ts as landed in E1's
 * PR-3 (commit 952d5b6): module-scope `let db: pg.Pool`, `before/after`
 * around setupTestDb / teardownTestDb, `beforeEach` truncate. Inline
 * `insertUser` / `insertOrg` / etc. helpers duplicated from that file — a
 * shared fixtures module is a follow-up when a third test file needs them.
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

async function insertFolder(
  projectId: string,
  parentFolderId: string | null,
  name: string,
  createdBy: string,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO folders (id, project_id, parent_folder_id, name, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
    [id, projectId, parentFolderId, name, createdBy],
  )
  return id
}

async function insertDocument(
  folderId: string,
  title: string,
  createdBy: string,
  kind: 'authored' | 'technical-sheet' | 'template' = 'authored',
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
    [id, folderId, title, kind, createdBy],
  )
  return id
}

// ------------------------------------------------------------------- tests

test('project INSERT populates lifecycle columns and creator-auto-owns fires', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)

  const row = await db.query<{
    description: string | null
    updated_at: Date
    archived_at: Date | null
  }>(
    `SELECT description, updated_at, archived_at FROM projects WHERE id = $1`,
    [proj],
  )
  assert.equal(row.rows[0]?.description, null)
  assert.ok(row.rows[0]?.updated_at instanceof Date, 'updated_at defaults to now()')
  assert.equal(row.rows[0]?.archived_at, null)

  // E1's aiper_creator_auto_owns from 004 must have inserted an owner grant
  // for the creator, atomically with the INSERT.
  const role = await db.query<{ role: string | null }>(
    `SELECT aiper_effective_access($1, 'project', $2) AS role`,
    [alex, proj],
  )
  assert.equal(role.rows[0]?.role, 'owner')
})

test('folder INSERT fires auto-owns, and self-parent UPDATE is rejected', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, null, 'TCS', alex)

  const role = await db.query<{ role: string | null }>(
    `SELECT aiper_effective_access($1, 'folder', $2) AS role`,
    [alex, fold],
  )
  assert.equal(role.rows[0]?.role, 'owner')

  // folders_no_self_parent from 006 — an UPDATE pointing a folder at itself
  // must fail. INSERT can't hit this (self-id can't exist yet as parent),
  // so UPDATE is the exercising path.
  await assert.rejects(
    () => db.query(`UPDATE folders SET parent_folder_id = id WHERE id = $1`, [fold]),
    /folders_no_self_parent/,
  )
})

test('document INSERT with kind + snapshot + lifecycle columns; auto-owns via chain', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, null, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report for MISSION-X TCS — Rev 2', alex, 'authored')

  const row = await db.query<{
    kind: string
    current_snapshot_id: string | null
    updated_at: Date
    archived_at: Date | null
  }>(
    `SELECT kind, current_snapshot_id, updated_at, archived_at
       FROM documents WHERE id = $1`,
    [doc],
  )
  assert.equal(row.rows[0]?.kind, 'authored')
  assert.equal(row.rows[0]?.current_snapshot_id, null)
  assert.ok(row.rows[0]?.updated_at instanceof Date)
  assert.equal(row.rows[0]?.archived_at, null)

  const role = await db.query<{ role: string | null }>(
    `SELECT aiper_effective_access($1, 'document', $2) AS role`,
    [alex, doc],
  )
  assert.equal(role.rows[0]?.role, 'owner')
})

test('document kind CHECK rejects an unknown kind', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, null, 'TCS', alex)

  await assert.rejects(
    () => db.query(
      `INSERT INTO documents (id, folder_id, title, kind, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), fold, 'x', 'sketch', alex],
    ),
    /documents_kind_check/,
  )
})

test('comments INSERT, and delete of parent document CASCADEs to comments', async () => {
  const alex = await insertUser('alex@example.com', 'Alex Kim')
  const org = await insertOrg('Acme Satellites')
  const proj = await insertProject(org, 'MISSION-X', alex)
  const fold = await insertFolder(proj, null, 'TCS', alex)
  const doc = await insertDocument(fold, 'TVAC Report', alex, 'authored')

  await db.query(
    `INSERT INTO comments
       (document_id, mark_id, quoted_text, body, author_id, author_display_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [doc, 'yjs-mark-abc', 'radiator area', 'should this be 1.4 m²?', alex, 'Alex Kim'],
  )

  const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM comments`)
  assert.equal(before.rows[0]?.n, '1')

  await db.query(`DELETE FROM documents WHERE id = $1`, [doc])

  const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM comments`)
  assert.equal(after.rows[0]?.n, '0')
})
