/**
 * Runtime validators mirroring ../types/audit.ts. Used to type the
 * response schemas of audit routes so OpenAPI documents them the same
 * way the TS interfaces describe them.
 */

import { z } from 'zod'

/**
 * Local mirror of AiperSubjectSchema from ./index.ts. Inlined rather
 * than imported because ./index.ts re-exports this file — importing
 * back would put AiperSubjectSchema in the temporal dead zone during
 * this module's init. The three literals here MUST match ./index.ts's
 * AiperSubjectSchema; a divergence would fail the AuditEntry type
 * check against @aiper/shared/types (which imports AiperSubject from
 * ./types/index.ts).
 */
const SubjectEnum = z.enum(['project', 'folder', 'document'])

export const AuditEntrySchema = z.object({
  userId: z.string().uuid(),
  printedName: z.string().min(1),
  action: z.string().min(1),
  subjectType: SubjectEnum,
  subjectId: z.string().uuid(),
  revisionBefore: z.number().int().nullable().optional(),
  revisionAfter: z.number().int().nullable().optional(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  reason: z.string().nullable().optional(),
})

export const ChainVerificationSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int().nonnegative(),
  brokenAtId: z.number().int().nullable(),
  detail: z.string(),
})
