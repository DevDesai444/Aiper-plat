import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DocumentSnapshotSchema,
  SaveRequestSchema,
  SnapshotListSchema,
  SnapshotReasonSchema,
} from '../src/schemas/index.js'

// Fixtures — line up UUIDs and a fixed ISO timestamp so the individual
// tests read as behaviour, not string wrangling.
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
const UUID_C = '33333333-3333-3333-3333-333333333333'
const NOW = '2026-01-15T10:30:00.000Z'

// -------------------------------------------------------------------- SnapshotReason
test('SnapshotReasonSchema accepts the three reasons', () => {
  assert.equal(SnapshotReasonSchema.parse('auto'), 'auto')
  assert.equal(SnapshotReasonSchema.parse('checkpoint'), 'checkpoint')
  assert.equal(SnapshotReasonSchema.parse('release'), 'release')
})

test('SnapshotReasonSchema rejects other values', () => {
  assert.throws(() => SnapshotReasonSchema.parse('manual'))
  assert.throws(() => SnapshotReasonSchema.parse(''))
  assert.throws(() => SnapshotReasonSchema.parse(null))
})

// -------------------------------------------------------------------- DocumentSnapshot
test('DocumentSnapshotSchema parses a well-formed labelled checkpoint', () => {
  const parsed = DocumentSnapshotSchema.parse({
    id: UUID_A,
    documentId: UUID_B,
    savedBy: UUID_C,
    savedAt: NOW,
    reason: 'checkpoint',
    label: 'Baseline review complete',
  })
  assert.equal(parsed.reason, 'checkpoint')
  assert.equal(parsed.label, 'Baseline review complete')
})

test('DocumentSnapshotSchema parses an unlabelled auto-snapshot (label:null)', () => {
  const parsed = DocumentSnapshotSchema.parse({
    id: UUID_A,
    documentId: UUID_B,
    savedBy: UUID_C,
    savedAt: NOW,
    reason: 'auto',
    label: null,
  })
  assert.equal(parsed.reason, 'auto')
  assert.equal(parsed.label, null)
})

test('DocumentSnapshotSchema rejects non-uuid ids and non-ISO timestamps', () => {
  assert.throws(() =>
    DocumentSnapshotSchema.parse({
      id: 'not-a-uuid',
      documentId: UUID_B,
      savedBy: UUID_C,
      savedAt: NOW,
      reason: 'checkpoint',
      label: null,
    }),
  )
  assert.throws(() =>
    DocumentSnapshotSchema.parse({
      id: UUID_A,
      documentId: UUID_B,
      savedBy: UUID_C,
      savedAt: '2026-01-15 10:30:00', // no T, no offset
      reason: 'checkpoint',
      label: null,
    }),
  )
})

test('DocumentSnapshotSchema rejects a label past the 200-char cap', () => {
  assert.throws(() =>
    DocumentSnapshotSchema.parse({
      id: UUID_A,
      documentId: UUID_B,
      savedBy: UUID_C,
      savedAt: NOW,
      reason: 'checkpoint',
      label: 'x'.repeat(201),
    }),
  )
})

test('DocumentSnapshotSchema rejects an empty-string label (use null instead)', () => {
  // The type is `string | null`, not `''` — the DB column matches; keeping
  // the schema strict prevents the "was it empty or was it missing?" bug.
  assert.throws(() =>
    DocumentSnapshotSchema.parse({
      id: UUID_A,
      documentId: UUID_B,
      savedBy: UUID_C,
      savedAt: NOW,
      reason: 'checkpoint',
      label: '',
    }),
  )
})

// -------------------------------------------------------------------- SnapshotList
test('SnapshotListSchema parses a list of one', () => {
  const parsed = SnapshotListSchema.parse({
    snapshots: [
      {
        id: UUID_A,
        documentId: UUID_B,
        savedBy: UUID_C,
        savedAt: NOW,
        reason: 'release',
        label: 'v1.0',
      },
    ],
  })
  assert.equal(parsed.snapshots.length, 1)
  assert.equal(parsed.snapshots[0]?.reason, 'release')
})

test('SnapshotListSchema parses an empty list', () => {
  const parsed = SnapshotListSchema.parse({ snapshots: [] })
  assert.equal(parsed.snapshots.length, 0)
})

// -------------------------------------------------------------------- SaveRequest
test('SaveRequestSchema accepts an empty body (unlabelled checkpoint)', () => {
  const parsed = SaveRequestSchema.parse({})
  assert.equal(parsed.reason, undefined)
  assert.equal(parsed.label, undefined)
})

test('SaveRequestSchema accepts a body with reason + label', () => {
  const parsed = SaveRequestSchema.parse({
    reason: 'Approved by reviewer A',
    label: 'Baseline v3',
  })
  assert.equal(parsed.reason, 'Approved by reviewer A')
  assert.equal(parsed.label, 'Baseline v3')
})

test('SaveRequestSchema accepts explicit nulls for both fields', () => {
  const parsed = SaveRequestSchema.parse({ reason: null, label: null })
  assert.equal(parsed.reason, null)
  assert.equal(parsed.label, null)
})

test('SaveRequestSchema rejects an over-long reason', () => {
  assert.throws(() => SaveRequestSchema.parse({ reason: 'x'.repeat(2_001) }))
})

test('SaveRequestSchema rejects an over-long label', () => {
  assert.throws(() => SaveRequestSchema.parse({ label: 'x'.repeat(201) }))
})
