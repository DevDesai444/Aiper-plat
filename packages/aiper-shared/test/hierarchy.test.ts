import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CommentSchema,
  DocumentKindSchema,
  DocumentSchema,
  FolderSchema,
  OrganizationSchema,
  ProjectFolderTreeSchema,
  ProjectSchema,
  SlugSchema,
} from '../src/schemas/index.js'

// Reusable fixtures — keep the individual tests readable by pushing the
// noisy UUIDs and timestamps into constants.
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
const UUID_C = '33333333-3333-3333-3333-333333333333'
const UUID_D = '44444444-4444-4444-4444-444444444444'
const NOW = '2026-01-15T10:30:00.000Z'

test('SlugSchema accepts lowercase kebab-case', () => {
  assert.equal(SlugSchema.parse('acme'), 'acme')
  assert.equal(SlugSchema.parse('acme-satellites'), 'acme-satellites')
  assert.equal(SlugSchema.parse('mission-x-2026'), 'mission-x-2026')
})

test('SlugSchema rejects uppercase, underscores, leading/trailing hyphens, and empty', () => {
  assert.throws(() => SlugSchema.parse('Acme'))
  assert.throws(() => SlugSchema.parse('acme_satellites'))
  assert.throws(() => SlugSchema.parse('-acme'))
  assert.throws(() => SlugSchema.parse('acme-'))
  assert.throws(() => SlugSchema.parse(''))
  assert.throws(() => SlugSchema.parse('a'.repeat(65)))
})

test('DocumentKindSchema accepts the three kinds', () => {
  assert.equal(DocumentKindSchema.parse('authored'), 'authored')
  assert.equal(DocumentKindSchema.parse('technical-sheet'), 'technical-sheet')
  assert.equal(DocumentKindSchema.parse('template'), 'template')
})

test('DocumentKindSchema rejects other values', () => {
  assert.throws(() => DocumentKindSchema.parse('authored-doc'))
  assert.throws(() => DocumentKindSchema.parse(''))
  assert.throws(() => DocumentKindSchema.parse(null))
})

test('OrganizationSchema parses a well-formed org', () => {
  const parsed = OrganizationSchema.parse({
    id: UUID_A,
    name: 'Acme Satellites',
    slug: 'acme-satellites',
    createdAt: NOW,
  })
  assert.equal(parsed.slug, 'acme-satellites')
})

test('OrganizationSchema rejects bad slug or missing name', () => {
  assert.throws(() =>
    OrganizationSchema.parse({ id: UUID_A, name: 'Acme', slug: 'Bad Slug', createdAt: NOW }),
  )
  assert.throws(() =>
    OrganizationSchema.parse({ id: UUID_A, name: '', slug: 'acme', createdAt: NOW }),
  )
})

test('ProjectSchema parses a well-formed project with a role', () => {
  const parsed = ProjectSchema.parse({
    id: UUID_A,
    orgId: UUID_B,
    name: 'MISSION-X Payload',
    slug: 'mission-x-payload',
    createdBy: UUID_C,
    createdAt: NOW,
    myRole: 'owner',
  })
  assert.equal(parsed.myRole, 'owner')
})

test('ProjectSchema accepts null myRole and rejects an unknown role', () => {
  assert.equal(
    ProjectSchema.parse({
      id: UUID_A,
      orgId: UUID_B,
      name: 'P',
      slug: 'p',
      createdBy: UUID_C,
      createdAt: NOW,
      myRole: null,
    }).myRole,
    null,
  )
  assert.throws(() =>
    ProjectSchema.parse({
      id: UUID_A,
      orgId: UUID_B,
      name: 'P',
      slug: 'p',
      createdBy: UUID_C,
      createdAt: NOW,
      myRole: 'admin',
    }),
  )
})

test('FolderSchema parses a root folder and a nested folder', () => {
  const root = FolderSchema.parse({
    id: UUID_A,
    projectId: UUID_B,
    parentFolderId: null,
    name: 'TCS',
    createdBy: UUID_C,
    createdAt: NOW,
    myRole: 'editor',
  })
  assert.equal(root.parentFolderId, null)

  const nested = FolderSchema.parse({
    id: UUID_D,
    projectId: UUID_B,
    parentFolderId: UUID_A,
    name: 'Thermal Analysis',
    createdBy: UUID_C,
    createdAt: NOW,
    myRole: 'viewer',
  })
  assert.equal(nested.parentFolderId, UUID_A)
})

test('FolderSchema rejects a non-uuid parentFolderId', () => {
  assert.throws(() =>
    FolderSchema.parse({
      id: UUID_A,
      projectId: UUID_B,
      parentFolderId: 'root',
      name: 'F',
      createdBy: UUID_C,
      createdAt: NOW,
      myRole: null,
    }),
  )
})

test('DocumentSchema parses a folder-parented document with a null current snapshot', () => {
  const parsed = DocumentSchema.parse({
    id: UUID_A,
    folderId: UUID_B,
    projectId: null,
    title: 'Test Report for TVAC of the TCS of MISSION-X — Rev 2',
    kind: 'authored',
    currentSnapshotId: null,
    createdBy: UUID_C,
    createdAt: NOW,
    myRole: 'owner',
  })
  assert.equal(parsed.currentSnapshotId, null)
  assert.equal(parsed.projectId, null)
})

test('DocumentSchema parses a project-parented document (folderId null)', () => {
  const parsed = DocumentSchema.parse({
    id: UUID_A,
    folderId: null,
    projectId: UUID_B,
    title: 'Project-level ICD',
    kind: 'authored',
    currentSnapshotId: null,
    createdBy: UUID_C,
    createdAt: NOW,
    myRole: 'owner',
  })
  assert.equal(parsed.folderId, null)
  assert.equal(parsed.projectId, UUID_B)
})

test('DocumentSchema rejects an unknown kind or over-long title', () => {
  assert.throws(() =>
    DocumentSchema.parse({
      id: UUID_A,
      folderId: UUID_B,
      projectId: null,
      title: 'x',
      kind: 'sketch',
      currentSnapshotId: null,
      createdBy: UUID_C,
      createdAt: NOW,
      myRole: null,
    }),
  )
  assert.throws(() =>
    DocumentSchema.parse({
      id: UUID_A,
      folderId: UUID_B,
      projectId: null,
      title: 'x'.repeat(301),
      kind: 'authored',
      currentSnapshotId: null,
      createdBy: UUID_C,
      createdAt: NOW,
      myRole: null,
    }),
  )
})

test('ProjectFolderTreeSchema parses a project with one folder and one document', () => {
  const parsed = ProjectFolderTreeSchema.parse({
    project: {
      id: UUID_A,
      orgId: UUID_B,
      name: 'MISSION-X',
      slug: 'mission-x',
      createdBy: UUID_C,
      createdAt: NOW,
      myRole: 'owner',
    },
    folders: [
      {
        folder: {
          id: UUID_D,
          projectId: UUID_A,
          parentFolderId: null,
          name: 'TCS',
          createdBy: UUID_C,
          createdAt: NOW,
          myRole: 'owner',
        },
        children: [],
        documents: [{ id: UUID_B, title: 'Radiator layout', kind: 'authored' }],
      },
    ],
  })
  assert.equal(parsed.folders.length, 1)
  assert.equal(parsed.folders[0]?.documents[0]?.kind, 'authored')
})

test('ProjectFolderTreeSchema rejects a tree missing the project field', () => {
  assert.throws(() => ProjectFolderTreeSchema.parse({ folders: [] }))
})

test('CommentSchema parses an unresolved and a resolved comment', () => {
  const open = CommentSchema.parse({
    id: UUID_A,
    documentId: UUID_B,
    markId: 'yjs-mark-abc',
    quotedText: 'The radiator area shall be at least 1.2 m²',
    body: 'Should this be 1.4 m² per the latest thermal budget?',
    authorId: UUID_C,
    authorDisplayName: 'Alex Kim',
    createdAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
  })
  assert.equal(open.resolvedAt, null)

  const closed = CommentSchema.parse({
    id: UUID_A,
    documentId: UUID_B,
    markId: 'yjs-mark-abc',
    quotedText: 'q',
    body: 'ack',
    authorId: UUID_C,
    authorDisplayName: 'Alex Kim',
    createdAt: NOW,
    resolvedAt: NOW,
    resolvedBy: UUID_D,
  })
  assert.equal(closed.resolvedBy, UUID_D)
})

test('CommentSchema rejects an empty body and an over-long body', () => {
  assert.throws(() =>
    CommentSchema.parse({
      id: UUID_A,
      documentId: UUID_B,
      markId: 'm',
      quotedText: '',
      body: '',
      authorId: UUID_C,
      authorDisplayName: 'A',
      createdAt: NOW,
      resolvedAt: null,
      resolvedBy: null,
    }),
  )
  assert.throws(() =>
    CommentSchema.parse({
      id: UUID_A,
      documentId: UUID_B,
      markId: 'm',
      quotedText: '',
      body: 'x'.repeat(10_001),
      authorId: UUID_C,
      authorDisplayName: 'A',
      createdAt: NOW,
      resolvedAt: null,
      resolvedBy: null,
    }),
  )
})
