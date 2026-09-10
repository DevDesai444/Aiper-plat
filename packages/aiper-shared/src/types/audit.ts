/**
 * Week-5 interface freeze for the audit chain.
 *
 * AuditEntry is the shape passed to writeAudit — no id/occurredAt/hashes,
 * those are DB-generated. A separate read-side interface for /api/v1/audit
 * (list-of-entries) will land alongside the first route that reads the
 * log. PR-4 only exposes /api/v1/audit/verify, which returns
 * ChainVerification.
 */

import type { AiperSubject } from './index.js'

export interface AuditEntry {
  userId: string
  printedName: string
  action: string
  subjectType: AiperSubject
  subjectId: string
  revisionBefore?: number | null
  revisionAfter?: number | null
  /** Free-form JSON, tampering-detected. Small objects only — the audit
   *  log is not a snapshot store. */
  oldValue?: unknown
  newValue?: unknown
  /** Free-text "why", carried through from the Save UI or the API caller. */
  reason?: string | null
}

export interface ChainVerification {
  ok: boolean
  /** Total number of rows the walk examined. */
  checked: number
  /** Row id where the chain first diverged; null when ok is true. */
  brokenAtId: number | null
  detail: string
}
