/**
 * Runtime validators mirroring ../types/doc-links.ts. Pair 1:1 with the
 * interfaces there; edit both files in the same PR.
 *
 * The relation enum here MUST match migration 011's CHECK constraint. A
 * new relation is a three-step edit: the CHECK, this schema, the type.
 */

import { z } from 'zod'
import { DocumentKindSchema } from './hierarchy.js'

// Local mirror of AiperRoleSchema — same temporal-dead-zone dodge as
// schemas/search.ts. See the comment there for why.
const RoleNotNull = z.enum(['viewer', 'editor', 'owner'])

export const DocumentLinkRelationSchema = z.enum([
  'verifies',
  'references',
  'derives-from',
  'supersedes',
  'conflicts-with',
])

export const DocumentLinkEndpointSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  kind: DocumentKindSchema,
  projectId: z.string().uuid(),
  projectName: z.string(),
})

export const DocumentLinkSchema = z.object({
  id: z.string().uuid(),
  relation: DocumentLinkRelationSchema,
  counterpart: DocumentLinkEndpointSchema,
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  counterpartRole: RoleNotNull,
})

export const DocumentLinksResponseSchema = z.object({
  outgoing: z.array(DocumentLinkSchema),
  incoming: z.array(DocumentLinkSchema),
})

export const DocumentLinkCreateInputSchema = z.object({
  targetDocumentId: z.string().uuid(),
  relation: DocumentLinkRelationSchema,
})
