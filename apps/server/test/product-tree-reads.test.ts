/**
 * Product-tree read routes.
 *
 * Pattern matches read-routes.test.ts and save-flow.test.ts: one
 * buildServer + pool for the whole file, JWTs signed with jose/HS256,
 * seed helpers inline. Access to nodes rides the parent project's
 * grants (Option B in the signed-off design); the 404-existence-hiding
 * guard collapses non-existent-subject and no-grant to one status.
 */

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
const MISSING_UUID = '99999999-9999-9999-9999-999999999999'

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
  displayName: string
  token: string
}

async function seedUser(email: string, displayName: string): Promise<SeededUser> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    [id, email, displayName],
  )
  return { id, displayName, token: await signToken(id, email, displayName) }
}

async function seedOrg(name: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)',
    [id, name, name.toLowerCase().replace(/\s+/g, '-')],
  )
  return id
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
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, $3, 'authored', $4)`,
    [id, folderId, title, createdBy],
  )
  return id
}

async function seedNode(
  projectId: string,
  parentNodeId: string | null,
  kind: 'assembly' | 'subassembly' | 'component' | 'part',
  name: string,
  createdBy: string,
  extras: { partNumber?: string | null; attributes?: Record<string, unknown> } = {},
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO product_nodes
       (id, project_id, parent_node_id, kind, name, part_number, attributes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      projectId,
      parentNodeId,
      kind,
      name,
      extras.partNumber ?? null,
      extras.attributes ? JSON.stringify(extras.attributes) : '{}',
      createdBy,
    ],
  )
  return id
}

async function archiveNode(nodeId: string): Promise<void> {
  await db.query(`UPDATE product_nodes SET archived_at = now() WHERE id = $1`, [nodeId])
}

async function grantRole(
  subjectType: 'project' | 'folder' | 'document',
  subjectId: string,
  userId: string,
  role: 'viewer' | 'editor' | 'owner',
  granter: string,
): Promise<void> {
  await db.query(
    `INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
     VALUES ($1, $2, 'user', $3::text, $4, $5)`,
    [subjectType, subjectId, userId, role, granter],
  )
}

async function linkNodeDoc(
  nodeId: string,
  docId: string,
  relation: 'reference' | 'design-spec' | 'test-report' | 'sign-off' | 'requirement',
  createdBy: string,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO product_node_documents (id, product_node_id, document_id, relation, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, nodeId, docId, relation, createdBy],
  )
  return id
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// Small fixture — Alice owns a MISSION-X project via auto-owns.
async function seedAliceProject(): Promise<{ alice: SeededUser; org: string; project: string }> {
  const alice = await seedUser('alice@example.com', 'Alice')
  const org = await seedOrg('Acme Satellites')
  const project = await seedProject(org, 'MISSION-X', alice.id)
  return { alice, org, project }
}

// ============================================================================
// GET /api/v1/projects/:pid/product-tree
// ============================================================================

test('GET /product-tree returns 401 without a JWT', async () => {
  const { project } = await seedAliceProject()
  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/product-tree` })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'no_session')
})

test('GET /product-tree returns 404 for a bogus :pid (existence-leak guard)', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${MISSING_UUID}/product-tree`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('GET /product-tree returns 404 for a caller with no grant on the project', async () => {
  const { project } = await seedAliceProject()
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/product-tree`,
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 404, 'no-grant collapses to 404, not 403')
})

test('GET /product-tree returns 200 with DFS preorder + siblings by lower(name), myRole populated', async () => {
  const { alice, project } = await seedAliceProject()

  //          project
  //          /      \
  //       ADCS     Payload
  //                  \
  //             Optical Bench
  //                    \
  //                Detector
  const adcs         = await seedNode(project, null,     'assembly',    'ADCS',         alice.id)
  const payload      = await seedNode(project, null,     'assembly',    'Payload',      alice.id)
  const opticalBench = await seedNode(project, payload,  'subassembly', 'Optical Bench',alice.id)
  const detector     = await seedNode(project, opticalBench, 'component', 'Detector',   alice.id, {
    partNumber: 'DET-42',
    attributes: { mass_kg: 0.5 },
  })

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/product-tree`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as {
    project: { id: string; myRole: string }
    nodes: Array<{ id: string; name: string; parentNodeId: string | null; myRole: string; attributes: Record<string, unknown> }>
  }
  assert.equal(body.project.id, project)
  assert.equal(body.project.myRole, 'owner', 'alice created it → owner via auto-owns')

  // DFS preorder from every root, siblings alphabetical (case-insensitive):
  // roots: ADCS (a...), Payload (p...) → ADCS first, then Payload subtree.
  assert.deepEqual(
    body.nodes.map((n) => n.id),
    [adcs, payload, opticalBench, detector],
    'DFS preorder from roots, siblings by lower(name)',
  )
  // myRole inherited from the project on every node.
  assert.ok(body.nodes.every((n) => n.myRole === 'owner'))
  // JSONB attributes round-trip intact.
  assert.deepEqual(body.nodes[3]!.attributes, { mass_kg: 0.5 })
})

test('GET /product-tree exposes myRole=viewer to a viewer-grant caller', async () => {
  const { alice, project } = await seedAliceProject()
  const bob = await seedUser('bob@example.com', 'Bob')
  await grantRole('project', project, bob.id, 'viewer', alice.id)
  await seedNode(project, null, 'assembly', 'Payload', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/product-tree`,
    headers: authHeaders(bob.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { project: { myRole: string }; nodes: Array<{ myRole: string }> }
  assert.equal(body.project.myRole, 'viewer')
  assert.ok(body.nodes.every((n) => n.myRole === 'viewer'))
})

test('GET /product-tree excludes archived nodes', async () => {
  const { alice, project } = await seedAliceProject()
  const alive = await seedNode(project, null, 'assembly', 'Payload', alice.id)
  const buried = await seedNode(project, null, 'assembly', 'ADCS', alice.id)
  await archiveNode(buried)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project}/product-tree`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { nodes: Array<{ id: string }> }
  assert.deepEqual(
    body.nodes.map((n) => n.id),
    [alive],
    'archived nodes filtered out',
  )
})

// ============================================================================
// GET /api/v1/product-nodes/:nid
// ============================================================================

test('GET /product-nodes/:nid — 401, 404 (missing / no-grant), 200 with myRole', async () => {
  const { alice, project } = await seedAliceProject()
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const node = await seedNode(project, null, 'component', 'Detector', alice.id)

  // 401 — no jwt
  {
    const res = await app.inject({ method: 'GET', url: `/api/v1/product-nodes/${node}` })
    assert.equal(res.statusCode, 401)
  }
  // 404 — non-existent
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/product-nodes/${MISSING_UUID}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 404)
  }
  // 404 — no grant (existence-leak parity)
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/product-nodes/${node}`,
      headers: authHeaders(outsider.token),
    })
    assert.equal(res.statusCode, 404)
  }
  // 200 — creator sees it
  {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/product-nodes/${node}`,
      headers: authHeaders(alice.token),
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { id: string; kind: string; name: string; myRole: string }
    assert.equal(body.id, node)
    assert.equal(body.kind, 'component')
    assert.equal(body.name, 'Detector')
    assert.equal(body.myRole, 'owner')
  }
})

// ============================================================================
// GET /api/v1/product-nodes/:nid/children
// ============================================================================

test('GET /product-nodes/:nid/children lists non-archived direct children only, alphabetical', async () => {
  const { alice, project } = await seedAliceProject()
  const parent = await seedNode(project, null, 'assembly', 'Payload', alice.id)
  const c1 = await seedNode(project, parent, 'subassembly', 'Zeta Bench', alice.id)
  const c2 = await seedNode(project, parent, 'subassembly', 'Alpha Bench', alice.id)
  const c3 = await seedNode(project, parent, 'subassembly', 'Buried Bench', alice.id)
  await archiveNode(c3)
  // Grandchild — must NOT appear in the direct-children list.
  await seedNode(project, c1, 'component', 'Grandchild', alice.id)

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/product-nodes/${parent}/children`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const items = (res.json() as { items: Array<{ id: string; name: string }> }).items
  assert.deepEqual(
    items.map((n) => n.id),
    [c2, c1],
    'direct children only, ordered by lower(name); archived excluded',
  )
})

test('GET /product-nodes/:nid/children returns 404 for a bogus :nid', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/product-nodes/${MISSING_UUID}/children`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 404)
})

// ============================================================================
// GET /api/v1/documents/:did/nodes  — reverse doc↔node lookup
// ============================================================================

test('GET /documents/:did/nodes — 401 without a JWT', async () => {
  const { alice, project } = await seedAliceProject()
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id)
  const res = await app.inject({ method: 'GET', url: `/api/v1/documents/${doc}/nodes` })
  assert.equal(res.statusCode, 401)
})

test('GET /documents/:did/nodes — 404 when caller has no grant on the doc', async () => {
  const { alice, project } = await seedAliceProject()
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id)
  const outsider = await seedUser('outsider@example.com', 'Outsider')

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/nodes`,
    headers: authHeaders(outsider.token),
  })
  assert.equal(res.statusCode, 404)
})

test('GET /documents/:did/nodes returns links to accessible nodes only, allows multiple relations for same pair', async () => {
  // Alice owns a project + doc. She links her doc to a node in
  // her project (accessible), AND to a node in an outsider's
  // project (not accessible). Only the accessible link comes back.
  const { alice, project: aliceProject } = await seedAliceProject()
  const folder = await seedFolder(aliceProject, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'TVAC Report', alice.id)
  const aliceNode = await seedNode(aliceProject, null, 'component', 'Detector', alice.id)
  await linkNodeDoc(aliceNode, doc, 'design-spec', alice.id)
  await linkNodeDoc(aliceNode, doc, 'sign-off', alice.id)  // same pair, different relation

  // Outsider's project + node. Alice's doc is linked here too, but
  // Alice has no grant on this project.
  const outsider = await seedUser('outsider@example.com', 'Outsider')
  const outsiderOrg = await seedOrg('Other Corp')
  const outsiderProject = await seedProject(outsiderOrg, 'MOON-Y', outsider.id)
  const outsiderNode = await seedNode(outsiderProject, null, 'component', 'Widget', outsider.id)
  await linkNodeDoc(outsiderNode, doc, 'reference', outsider.id)
  // Grant outsider viewer+ on Alice's doc so the linkNodeDoc from
  // outsider's side has been done by someone with access — but the
  // real point is Alice cannot see the outsider's node. Alice IS
  // the one hitting the route below.

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/nodes`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  const items = (res.json() as { items: Array<{ productNodeId: string; relation: string }> }).items
  // Two link rows for the same (node, doc) pair — one design-spec,
  // one sign-off. The outsider node's link is filtered out.
  assert.equal(items.length, 2)
  assert.ok(items.every((l) => l.productNodeId === aliceNode))
  const relations = items.map((l) => l.relation).sort()
  assert.deepEqual(relations, ['design-spec', 'sign-off'])
})

test('GET /documents/:did/nodes returns an empty list when no nodes reference the doc', async () => {
  const { alice, project } = await seedAliceProject()
  const folder = await seedFolder(project, 'TCS', alice.id)
  const doc = await seedDocument(folder, 'Standalone Report', alice.id)
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${doc}/nodes`,
    headers: authHeaders(alice.token),
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { items: unknown[] }).items, [])
})
