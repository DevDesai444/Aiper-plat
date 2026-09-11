/**
 * Runtime validators mirroring ../types/search.ts. Pair 1:1 with the
 * interfaces there; edit both files in the same PR.
 */

import { z } from 'zod'
import { DocumentKindSchema } from './hierarchy.js'

// Local mirror of AiperRoleSchema for the same reason schemas/hierarchy.ts
// inlines its own copy — importing back through ../index.js would create a
// temporal-dead-zone problem during module init when this file is picked up
// through the barrel.
const RoleNotNull = z.enum(['viewer', 'editor', 'owner'])

export const SearchResultSchema = z.object({
  document: z.object({
    id: z.string().uuid(),
    title: z.string(),
    kind: DocumentKindSchema,
  }),
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
  folder: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
    })
    .nullable(),
  myRole: RoleNotNull,
})

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
})
