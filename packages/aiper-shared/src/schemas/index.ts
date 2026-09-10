/**
 * Runtime validators mirroring the interfaces in ../types. Consumers use
 * these at trust boundaries — JWT payload parsing, request body parsing,
 * response validation in tests.
 *
 * These schemas MUST stay in sync with ../types. If a field changes,
 * update both files in the same PR.
 */

import { z } from 'zod'

export const AiperRoleSchema = z.enum(['viewer', 'editor', 'owner'])

export const AiperSubjectSchema = z.enum(['project', 'folder', 'document'])

export const OrgMembershipSchema = z.object({
  orgId: z.string().uuid(),
  role: z.enum(['admin', 'member']),
})

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  orgMemberships: z.array(OrgMembershipSchema),
})

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
})

// Audit chain schemas — E1 owns; kept in their own file so this barrel
// does not grow linearly.
export * from './audit.js'

// Hierarchy schemas (organizations, projects, folders, documents, tree,
// comments) — E2 owns; kept in their own file so the two teams don't collide
// on this barrel every week.
export * from './hierarchy.js'

// Blob schemas (UploadResponseSchema) — pairs 1:1 with ../types/blobs.ts.
export * from './blobs.js'

// Snapshot schemas (DocumentSnapshotSchema, SnapshotListSchema,
// SaveRequestSchema, SnapshotReasonSchema) — E3 owns; pairs 1:1 with
// ../types/snapshots.ts.
export * from './snapshots.js'
