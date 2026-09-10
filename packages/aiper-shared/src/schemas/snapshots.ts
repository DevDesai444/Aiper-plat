/**
 * Runtime validators mirroring ../types/snapshots.ts. Consumers use these
 * at trust boundaries — request body parsing on POST /save, response
 * validation on GET /history, and in tests.
 *
 * These schemas MUST stay in sync with ../types/snapshots.ts. If a field
 * changes, update both files in the same PR.
 */

import { z } from 'zod'

/** ISO 8601 with offset (matches PostgreSQL timestamptz JSON serialisation).
 *  Inlined here rather than imported from ./hierarchy.js so the two schema
 *  files stay independently loadable; they are re-exported through the
 *  same barrel (../schemas/index.ts) and importing between them creates
 *  temporal-dead-zone risk on module init. */
const IsoDateTimeSchema = z.string().datetime({ offset: true })

/**
 * Human-visible name shown in the Save timeline. Short — the UI renders
 * one row per snapshot and a 200-char cap keeps the row height stable.
 * Nullable because auto-snapshots and unlabelled checkpoints carry null,
 * matching the DB column and the TS type.
 */
const LabelSchema = z.string().min(1).max(200).nullable()

/**
 * Free-text "why" a Save happened, carried into audit_log.reason. Capped
 * larger than a label but small enough that the audit log stays a log —
 * a full paragraph of context fits, a copy-pasted document does not.
 */
const ReasonSchema = z.string().min(1).max(2_000)

export const SnapshotReasonSchema = z.enum(['auto', 'checkpoint', 'release'])

export const DocumentSnapshotSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  savedBy: z.string().uuid(),
  savedAt: IsoDateTimeSchema,
  reason: SnapshotReasonSchema,
  label: LabelSchema,
})

export const SnapshotListSchema = z.object({
  snapshots: z.array(DocumentSnapshotSchema),
})

/**
 * Both fields accept null (an explicit "no value") and undefined (field
 * omitted from the body), matching the TS SaveRequest — a bare `{}` POST
 * is a valid, unlabelled checkpoint Save.
 */
export const SaveRequestSchema = z.object({
  reason: ReasonSchema.nullable().optional(),
  label: z.string().min(1).max(200).nullable().optional(),
})
