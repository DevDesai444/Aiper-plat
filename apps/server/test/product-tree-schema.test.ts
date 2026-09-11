/**
 * Verifies migration 010 — product_nodes + product_node_documents.
 *
 * Pattern mirrors apps/server/test/hierarchy-schema.test.ts and
 * snapshots-schema.test.ts as landed in E2/E3's schema PRs. Fixture
 * helpers are inlined; a shared fixtures module is a follow-up when
 * a fourth schema test file needs them.
 *
 * Coverage:
 *   - product_nodes: kind CHECK, self-parent CHECK, project CASCADE,
 *     parent-node CASCADE, JSONB attributes round-trip.
 *   - product_node_documents: all five relation values accepted,
 *     unknown relation rejected, UNIQUE (node, doc, relation),
 *     both-endpoint CASCADEs on delete.
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
       VALUES ($1, $2, NULL, $3, $4)`,
    [id, projectId, name, createdBy],
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

async function insertProductNode(
  projectId: string,
  parentNodeId: string | null,
  kind: 'assembly' | 'subassembly' | 'component' | 'part',
  name: string,
  createdBy: string,
  extras: {
    partNumber?: string
    description?: string
    attributes?: Record<string, unknown>
  } = {},
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO product_nodes
       (id, project_id, parent_node_id, kind, name, part_number, description, attributes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      projectId,
      parentNodeId,
      kind,
      name,
      extras.partNumber ?? null,
      extras.description ?? null,
      extras.attributes ? JSON.stringify(extras.attributes) : '{}',
      createdBy,
    ],
  )
  return id
}

// Compact fixture — org, project, one user. Used by every case.
async function seedProject(): Promise<{ alice: string; project: string; folder: string; doc: string }> {
  const alice = await insertUser('alice@example.com', 'Alice')
  const org = await insertOrg('Acme Satellites')
  const project = await insertProject(org, 'MISSION-X', alice)
  const folder = await insertFolder(project, 'TCS', alice)
  const doc = await insertDocument(folder, 'TVAC Report', alice)
  return { alice, project, folder, doc }
}

// ============================================================================
// product_nodes
// ============================================================================

test('product_node INSERT round-trips every column, defaults land, JSONB survives', async () => {
  const { alice, project } = await seedProject()

  const node = await insertProductNode(project, null, 'assembly', 'Payload', alice, {
    partNumber: 'PL-2026-01',
    description: 'Primary science payload',
    attributes: { mass_kg: 12.4, power_w: 45, trl: 6, radiation_hardened: true },
  })

  const row = await db.query<{
    project_id: string
    parent_node_id: string | null
    kind: string
    name: string
    part_number: string | null
    description: string | null
    attributes: Record<string, unknown>
    created_by: string
    created_at: Date
    updated_at: Date
    archived_at: Date | null
  }>(
    `SELECT project_id, parent_node_id, kind, name, part_number, description,
            attributes, created_by, created_at, updated_at, archived_at
       FROM product_nodes WHERE id = $1`,
    [node],
  )
  assert.equal(row.rowCount, 1)
  const r = row.rows[0]!
  assert.equal(r.project_id, project)
  assert.equal(r.parent_node_id, null)
  assert.equal(r.kind, 'assembly')
  assert.equal(r.name, 'Payload')
  assert.equal(r.part_number, 'PL-2026-01')
  assert.equal(r.description, 'Primary science payload')
  assert.deepEqual(r.attributes, {
    mass_kg: 12.4,
    power_w: 45,
    trl: 6,
    radiation_hardened: true,
  })
  assert.equal(r.created_by, alice)
  assert.ok(r.created_at instanceof Date)
  assert.ok(r.updated_at instanceof Date)
  assert.equal(r.archived_at, null)
})

test('product_node accepts all four kinds', async () => {
  const { alice, project } = await seedProject()
  const kinds = ['assembly', 'subassembly', 'component', 'part'] as const
  for (const k of kinds) {
    await insertProductNode(project, null, k, `Node-${k}`, alice)
  }
  const count = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_nodes`,
  )
  assert.equal(count.rows[0]!.n, '4')
})

test('product_node kind CHECK rejects an unknown kind', async () => {
  const { alice, project } = await seedProject()
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO product_nodes (id, project_id, kind, name, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), project, 'widget', 'Widget', alice],
      ),
    /product_nodes_kind_check/,
  )
})

test('product_node parent-child link works and CASCADEs on parent delete', async () => {
  const { alice, project } = await seedProject()
  const assembly = await insertProductNode(project, null, 'assembly', 'Payload', alice)
  const subassembly = await insertProductNode(project, assembly, 'subassembly', 'Optical Bench', alice)
  const component = await insertProductNode(project, subassembly, 'component', 'Detector', alice)

  // Delete the top assembly — the whole subtree goes with it.
  await db.query(`DELETE FROM product_nodes WHERE id = $1`, [assembly])

  const remaining = await db.query<{ id: string }>(`SELECT id FROM product_nodes`)
  assert.equal(remaining.rowCount, 0, 'CASCADE removed the subassembly and component too')
  // Silence unused-variable lint — the constants document the tree we
  // built, not just the top-level id.
  void subassembly
  void component
})

test('product_nodes_no_self_parent rejects an UPDATE pointing a node at itself', async () => {
  const { alice, project } = await seedProject()
  const node = await insertProductNode(project, null, 'assembly', 'Payload', alice)

  await assert.rejects(
    () => db.query(`UPDATE product_nodes SET parent_node_id = id WHERE id = $1`, [node]),
    /product_nodes_no_self_parent/,
  )
})

test('deleting a project CASCADEs to every product_node in it', async () => {
  // Isolated fixture: NO folder or document under this project. The
  // folders FK on projects is RESTRICT (no CASCADE), so a project
  // with folders can never be hard-deleted anyway — this test
  // exercises the product_nodes → projects CASCADE specifically.
  const alice = await insertUser('alice@example.com', 'Alice')
  const org = await insertOrg('Acme Satellites')
  const project = await insertProject(org, 'MISSION-X', alice)

  await insertProductNode(project, null, 'assembly', 'Payload', alice)
  await insertProductNode(project, null, 'assembly', 'Bus', alice)
  const before = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_nodes WHERE project_id = $1`,
    [project],
  )
  assert.equal(before.rows[0]!.n, '2')

  await db.query(`DELETE FROM projects WHERE id = $1`, [project])

  const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM product_nodes`)
  assert.equal(after.rows[0]!.n, '0', 'project delete cascaded to nodes')
})

// ============================================================================
// product_node_documents
// ============================================================================

test('product_node_documents accepts all five relation values', async () => {
  const { alice, project, doc } = await seedProject()
  const node = await insertProductNode(project, null, 'component', 'Detector', alice)

  const relations = ['reference', 'design-spec', 'test-report', 'sign-off', 'requirement'] as const
  for (const rel of relations) {
    await db.query(
      `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
       VALUES ($1, $2, $3, $4)`,
      [node, doc, rel, alice],
    )
  }
  const count = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_node_documents WHERE product_node_id = $1`,
    [node],
  )
  assert.equal(count.rows[0]!.n, '5')
})

test('product_node_documents relation CHECK rejects an unknown value', async () => {
  const { alice, project, doc } = await seedProject()
  const node = await insertProductNode(project, null, 'component', 'Detector', alice)

  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
         VALUES ($1, $2, $3, $4)`,
        [node, doc, 'attachment', alice],
      ),
    /product_node_documents_relation_check/,
  )
})

test('product_node_documents UNIQUE prevents the same (node, doc, relation) twice', async () => {
  const { alice, project, doc } = await seedProject()
  const node = await insertProductNode(project, null, 'component', 'Detector', alice)

  await db.query(
    `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
     VALUES ($1, $2, 'design-spec', $3)`,
    [node, doc, alice],
  )
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
         VALUES ($1, $2, 'design-spec', $3)`,
        [node, doc, alice],
      ),
    /product_node_documents_product_node_id_document_id_relation_key/,
  )
})

test('product_node_documents allows same (node, doc) under two different relations', async () => {
  // A doc can be both a design-spec AND a sign-off for the same
  // component — two rows, two relations. Real case in v1.
  const { alice, project, doc } = await seedProject()
  const node = await insertProductNode(project, null, 'component', 'Detector', alice)

  await db.query(
    `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
     VALUES ($1, $2, 'design-spec', $3)`,
    [node, doc, alice],
  )
  await db.query(
    `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
     VALUES ($1, $2, 'sign-off', $3)`,
    [node, doc, alice],
  )

  const count = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_node_documents
      WHERE product_node_id = $1 AND document_id = $2`,
    [node, doc],
  )
  assert.equal(count.rows[0]!.n, '2')
})

test('deleting the linked product_node CASCADEs to its link rows', async () => {
  const { alice, project, doc } = await seedProject()
  const node = await insertProductNode(project, null, 'component', 'Detector', alice)
  await db.query(
    `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
     VALUES ($1, $2, 'design-spec', $3)`,
    [node, doc, alice],
  )
  await db.query(`DELETE FROM product_nodes WHERE id = $1`, [node])
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_node_documents`,
  )
  assert.equal(rows.rows[0]!.n, '0')
})

test('deleting the linked document CASCADEs to its link rows', async () => {
  const { alice, project, doc } = await seedProject()
  const node = await insertProductNode(project, null, 'component', 'Detector', alice)
  await db.query(
    `INSERT INTO product_node_documents (product_node_id, document_id, relation, created_by)
     VALUES ($1, $2, 'test-report', $3)`,
    [node, doc, alice],
  )
  await db.query(`DELETE FROM documents WHERE id = $1`, [doc])
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_node_documents`,
  )
  assert.equal(rows.rows[0]!.n, '0')
})

// ============================================================================
// Index sanity — the timeline scan for part-number lookup is a real
// customer query; make sure the partial index shipped.
// ============================================================================

test('product_nodes_part_number_idx is a partial index over non-null part_number', async () => {
  const idx = await db.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'product_nodes' AND indexname = 'product_nodes_part_number_idx'`,
  )
  assert.equal(idx.rowCount, 1)
  assert.match(idx.rows[0]!.indexdef, /part_number/)
  assert.match(idx.rows[0]!.indexdef, /WHERE.*part_number IS NOT NULL/)
})
