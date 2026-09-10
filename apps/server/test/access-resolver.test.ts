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

// ------------------------------------------------------------ small fixture helpers
// Every scenario needs to spin up a couple of users, an org, a project, and
// some folders. Inline SQL for each case was noisy, so wrap the shapes here.

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
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    id,
    name,
    name.toLowerCase().replace(/\s+/g, '-'),
  ])
  return id
}

async function insertProject(orgId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, orgId, name, name.toLowerCase().replace(/\s+/g, '-'), createdBy],
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
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, projectId, parentFolderId, name, createdBy],
  )
  return id
}

async function insertDocument(folderId: string, title: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO documents (id, folder_id, title, created_by) VALUES ($1, $2, $3, $4)',
    [id, folderId, title, createdBy],
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
       DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by`,
    [subjectType, subjectId, userId, role, grantedBy],
  )
}

async function resolve(
  userId: string,
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
): Promise<'viewer' | 'editor' | 'owner' | null> {
  const r = await db.query<{ role: 'viewer' | 'editor' | 'owner' | null }>(
    'SELECT aiper_effective_access($1, $2, $3) AS role',
    [userId, subjectType, subjectId],
  )
  return r.rows[0]?.role ?? null
}

// ---------------------------------------------------------------------------- tests

test('no grant anywhere returns null', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', p1)
  // p1 created the project → auto-owner, so use a different user for the check.
  const stranger = await insertUser('stranger@example.com', 'Stranger')
  assert.equal(await resolve(stranger, 'project', project), null)
})

test('creator of a project auto-owns it', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', p1)
  assert.equal(await resolve(p1, 'project', project), 'owner')
})

test('creator of a folder auto-owns it (and the folder inherits from the project too)', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', p1)
  const folder = await insertFolder(project, null, 'TCS', p1)
  assert.equal(await resolve(p1, 'folder', folder), 'owner')
})

test('creator of a document auto-owns it', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', p1)
  const folder = await insertFolder(project, null, 'TCS', p1)
  const doc = await insertDocument(folder, 'Report', p1)
  assert.equal(await resolve(p1, 'document', doc), 'owner')
})

test('project owner inherits owner on a folder inside it', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const p2 = await insertUser('p2@example.com', 'P2')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', p2)
  const folder = await insertFolder(project, null, 'TCS', p1) // P1 owns folder via creation
  // P2 is the project owner (via creator-auto-owns), so on any folder inside:
  assert.equal(await resolve(p2, 'folder', folder), 'owner')
})

test('project owner inherits owner on a document inside a nested folder', async () => {
  const p2 = await insertUser('p2@example.com', 'P2')
  const stranger = await insertUser('stranger@example.com', 'Stranger')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', p2)
  const outerFolder = await insertFolder(project, null, 'TCS', stranger)
  const innerFolder = await insertFolder(project, outerFolder, 'Thermal', stranger)
  const doc = await insertDocument(innerFolder, 'Test Report', stranger)
  assert.equal(await resolve(p2, 'document', doc), 'owner')
})

/**
 * The pinned test from the lead's PR-2 review. This is exactly what the
 * "highest role wins" rule is for: a folder owner cannot demote a project
 * owner inside their folder — the ancestor grant survives.
 */
test('a lower explicit grant on a nested folder does NOT demote the ancestor owner (P1/P2)', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const p2 = await insertUser('p2@example.com', 'P2')
  const org = await insertOrg('Acme')

  // P2 owns Project1 (via creator-auto-owns).
  const project1 = await insertProject(org, 'Project1', p2)
  // P1 owns Folder1 (via creator-auto-owns) inside Project1.
  const folder1 = await insertFolder(project1, null, 'Folder1', p1)

  // P1 explicitly grants P2 = viewer on Folder1.
  await grant('folder', folder1, p2, 'viewer', p1)

  // P2 must remain OWNER on Folder1 — the ancestor Project1 grant wins.
  assert.equal(await resolve(p2, 'folder', folder1), 'owner')
})

test('a higher explicit grant on a subtree BEATS a lower ancestor role', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const stranger = await insertUser('stranger@example.com', 'Stranger')
  const org = await insertOrg('Acme')

  // Some other person owns the project; P1 has viewer on the project.
  const project = await insertProject(org, 'MISSION-X', stranger)
  await grant('project', project, p1, 'viewer', stranger)

  // P1 is explicitly granted owner on a folder inside.
  const folder = await insertFolder(project, null, 'TCS', stranger)
  await grant('folder', folder, p1, 'owner', stranger)

  // Folder grant is the highest, so it wins.
  assert.equal(await resolve(p1, 'folder', folder), 'owner')
  // The project only has viewer, so that's what P1 sees at the project level.
  assert.equal(await resolve(p1, 'project', project), 'viewer')
})

test('sibling folders do not leak access — a grant on F1 does not reach F2', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const stranger = await insertUser('stranger@example.com', 'Stranger')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', stranger)
  const f1 = await insertFolder(project, null, 'F1', stranger)
  const f2 = await insertFolder(project, null, 'F2', stranger)

  await grant('folder', f1, p1, 'editor', stranger)

  assert.equal(await resolve(p1, 'folder', f1), 'editor')
  // F2 shares only the project ancestor, and P1 has no grant there.
  assert.equal(await resolve(p1, 'folder', f2), null)
})

test('editor on a project + no folder grant = editor on any folder inside', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const stranger = await insertUser('stranger@example.com', 'Stranger')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', stranger)
  await grant('project', project, p1, 'editor', stranger)
  const folder = await insertFolder(project, null, 'TCS', stranger)
  assert.equal(await resolve(p1, 'folder', folder), 'editor')
})

test('resolver walks correctly through a deeply nested folder chain', async () => {
  const p1 = await insertUser('p1@example.com', 'P1')
  const stranger = await insertUser('stranger@example.com', 'Stranger')
  const org = await insertOrg('Acme')
  const project = await insertProject(org, 'MISSION-X', stranger)
  await grant('project', project, p1, 'viewer', stranger)

  let parent: string | null = null
  for (const name of ['Level1', 'Level2', 'Level3', 'Level4', 'Level5']) {
    parent = await insertFolder(project, parent, name, stranger)
  }
  const deepestFolder = parent as string
  assert.equal(await resolve(p1, 'folder', deepestFolder), 'viewer')
})
