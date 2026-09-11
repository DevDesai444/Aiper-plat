import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NodeDocumentLinkListSchema,
  NodeDocumentRelationSchema,
  ProductNodeDocumentSchema,
  ProductNodeKindSchema,
  ProductNodeListSchema,
  ProductNodeSchema,
  ProductTreeResponseSchema,
} from '../src/schemas/index.js'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const U3 = '33333333-3333-3333-3333-333333333333'
const U4 = '44444444-4444-4444-4444-444444444444'
const NOW = '2026-01-15T10:30:00.000Z'

const NODE = {
  id: U1,
  projectId: U2,
  parentNodeId: null as string | null,
  kind: 'assembly' as const,
  name: 'Payload',
  partNumber: 'PL-2026-01',
  description: 'Primary science payload',
  attributes: { mass_kg: 12.4 },
  createdBy: U3,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null as string | null,
  myRole: 'owner' as const,
}

const PROJECT = {
  id: U2,
  orgId: U4,
  name: 'MISSION-X',
  slug: 'mission-x',
  createdBy: U3,
  createdAt: NOW,
  myRole: 'owner' as const,
}

// ------------------------------------------------------------ enums

test('ProductNodeKindSchema accepts all four kinds', () => {
  for (const k of ['assembly', 'subassembly', 'component', 'part'] as const) {
    assert.equal(ProductNodeKindSchema.parse(k), k)
  }
})

test('ProductNodeKindSchema rejects other values', () => {
  assert.throws(() => ProductNodeKindSchema.parse('widget'))
  assert.throws(() => ProductNodeKindSchema.parse(''))
  assert.throws(() => ProductNodeKindSchema.parse(null))
})

test('NodeDocumentRelationSchema accepts all five relations', () => {
  for (const r of ['reference', 'design-spec', 'test-report', 'sign-off', 'requirement'] as const) {
    assert.equal(NodeDocumentRelationSchema.parse(r), r)
  }
})

test('NodeDocumentRelationSchema rejects other values', () => {
  assert.throws(() => NodeDocumentRelationSchema.parse('attachment'))
  assert.throws(() => NodeDocumentRelationSchema.parse(''))
})

// ------------------------------------------------------------ ProductNode

test('ProductNodeSchema parses a well-formed root node', () => {
  const parsed = ProductNodeSchema.parse(NODE)
  assert.equal(parsed.name, 'Payload')
  assert.equal(parsed.parentNodeId, null)
  assert.equal(parsed.myRole, 'owner')
  assert.deepEqual(parsed.attributes, { mass_kg: 12.4 })
})

test('ProductNodeSchema parses a child node with parentNodeId set', () => {
  const parsed = ProductNodeSchema.parse({ ...NODE, id: U4, parentNodeId: U1, kind: 'component' })
  assert.equal(parsed.parentNodeId, U1)
  assert.equal(parsed.kind, 'component')
})

test('ProductNodeSchema tolerates empty attributes and archivedAt=null', () => {
  const parsed = ProductNodeSchema.parse({
    ...NODE,
    attributes: {},
    archivedAt: null,
    partNumber: null,
    description: null,
    myRole: null,
  })
  assert.equal(parsed.myRole, null)
  assert.equal(parsed.partNumber, null)
  assert.equal(parsed.description, null)
  assert.equal(parsed.archivedAt, null)
  assert.deepEqual(parsed.attributes, {})
})

test('ProductNodeSchema rejects malformed uuids and timestamps', () => {
  assert.throws(() => ProductNodeSchema.parse({ ...NODE, id: 'not-a-uuid' }))
  assert.throws(() => ProductNodeSchema.parse({ ...NODE, createdAt: '2026-01-15 10:30' }))
})

test('ProductNodeSchema rejects an empty name (min 1) and an over-long one (max 200)', () => {
  assert.throws(() => ProductNodeSchema.parse({ ...NODE, name: '' }))
  assert.throws(() => ProductNodeSchema.parse({ ...NODE, name: 'x'.repeat(201) }))
})

test('ProductNodeSchema rejects an unknown kind', () => {
  assert.throws(() => ProductNodeSchema.parse({ ...NODE, kind: 'widget' }))
})

// ------------------------------------------------------------ list envelopes

test('ProductNodeListSchema parses an empty and a one-item list', () => {
  assert.deepEqual(ProductNodeListSchema.parse({ items: [] }).items, [])
  const parsed = ProductNodeListSchema.parse({ items: [NODE] })
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0]?.name, 'Payload')
})

// ------------------------------------------------------------ tree response

test('ProductTreeResponseSchema composes ProjectSchema + node array', () => {
  const parsed = ProductTreeResponseSchema.parse({
    project: PROJECT,
    nodes: [NODE, { ...NODE, id: U4, parentNodeId: U1, kind: 'component', name: 'Detector' }],
  })
  assert.equal(parsed.project.id, U2)
  assert.equal(parsed.nodes.length, 2)
  assert.equal(parsed.nodes[1]?.parentNodeId, U1)
})

test('ProductTreeResponseSchema rejects a malformed project', () => {
  assert.throws(() =>
    ProductTreeResponseSchema.parse({
      project: { ...PROJECT, slug: 'Bad Slug' }, // slug rejects uppercase
      nodes: [],
    }),
  )
})

// ------------------------------------------------------------ link record

const LINK = {
  id: U1,
  productNodeId: U2,
  documentId: U3,
  relation: 'design-spec' as const,
  createdBy: U4,
  createdAt: NOW,
}

test('ProductNodeDocumentSchema parses a well-formed link', () => {
  const parsed = ProductNodeDocumentSchema.parse(LINK)
  assert.equal(parsed.relation, 'design-spec')
})

test('ProductNodeDocumentSchema rejects an unknown relation', () => {
  assert.throws(() => ProductNodeDocumentSchema.parse({ ...LINK, relation: 'attachment' }))
})

test('NodeDocumentLinkListSchema parses empty and populated lists', () => {
  assert.deepEqual(NodeDocumentLinkListSchema.parse({ items: [] }).items, [])
  assert.equal(NodeDocumentLinkListSchema.parse({ items: [LINK] }).items.length, 1)
})
