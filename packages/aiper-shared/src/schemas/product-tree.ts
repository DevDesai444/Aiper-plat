/**
 * Runtime validators mirroring ../types/product-tree.ts. Used at
 * trust boundaries — response validation on the read routes, request-
 * body parsing on the write routes (queued for a follow-up PR).
 *
 * These schemas MUST stay in sync with the types. If a field changes,
 * update both files in the same PR.
 */

import { z } from 'zod'
import { ProjectSchema } from './hierarchy.js'

/** ISO 8601 with offset — matches Postgres timestamptz JSON output
 *  and the same helper every other schema file uses. Inlined rather
 *  than imported from ./hierarchy.js to avoid a temporal-dead-zone
 *  hazard on module init (both files are re-exported through the
 *  barrel). */
const IsoDateTimeSchema = z.string().datetime({ offset: true })

/** Role-or-null — inlined for the same reason as IsoDateTimeSchema. */
const RoleOrNull = z.enum(['viewer', 'editor', 'owner']).nullable()

/** Cap sizes at the API boundary. `name` shares the folder/document
 *  scale — long enough for a fully-qualified ECSS part name; short
 *  enough that the row fits nicely in a UI list. `part_number` /
 *  `description` mirror the values E2's DocumentSchema uses. */
const NameSchema        = z.string().min(1).max(200)
const PartNumberSchema  = z.string().min(1).max(200).nullable()
const DescriptionSchema = z.string().max(10_000).nullable()

export const ProductNodeKindSchema = z.enum([
  'assembly',
  'subassembly',
  'component',
  'part',
])

export const NodeDocumentRelationSchema = z.enum([
  'reference',
  'design-spec',
  'test-report',
  'sign-off',
  'requirement',
])

export const ProductNodeSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  parentNodeId: z.string().uuid().nullable(),
  kind: ProductNodeKindSchema,
  name: NameSchema,
  partNumber: PartNumberSchema,
  description: DescriptionSchema,
  attributes: z.record(z.string(), z.unknown()),
  createdBy: z.string().uuid(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
  myRole: RoleOrNull,
})

export const ProductNodeDocumentSchema = z.object({
  id: z.string().uuid(),
  productNodeId: z.string().uuid(),
  documentId: z.string().uuid(),
  relation: NodeDocumentRelationSchema,
  createdBy: z.string().uuid(),
  createdAt: IsoDateTimeSchema,
})

/** Response envelope for GET /api/v1/product-nodes/:nid/children and
 *  every other list-of-nodes read. Same shape as E2's
 *  DocumentListResponse to keep the client-side pattern uniform. */
export const ProductNodeListSchema = z.object({
  items: z.array(ProductNodeSchema),
})

/** Response envelope for GET /api/v1/documents/:did/nodes. */
export const NodeDocumentLinkListSchema = z.object({
  items: z.array(ProductNodeDocumentSchema),
})

/** Response shape of the full-project tree endpoint. Composes the
 *  frozen ProjectSchema (E2) with the flat DFS preorder walk of
 *  nodes. Not circular: hierarchy.ts does not import from here. */
export const ProductTreeResponseSchema = z.object({
  project: ProjectSchema,
  nodes: z.array(ProductNodeSchema),
})
