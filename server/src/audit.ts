import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from './db.js'

export interface AuditEntry {
  userId: string | null
  printedName: string
  action: string
  documentId?: string | null
  revisionBefore?: number | null
  revisionAfter?: number | null
  oldValue?: unknown
  newValue?: unknown
  reason?: string | null
}

/**
 * Append one audit record, chaining it to the previous one.
 *
 * 21 CFR 11.10(e) wants a secure, computer-generated, time-stamped trail where record
 * changes do not obscure previously recorded information. The table rejects UPDATE, DELETE
 * and TRUNCATE, but a superuser can disable a trigger — so each row also carries a hash over
 * the row before it. Altering or removing any row breaks the chain from that point on, which
 * makes tampering detectable even when it cannot be prevented.
 *
 * Timestamps come from the database (now()), never the caller. Client clocks are not trusted.
 */
export async function writeAudit(entry: AuditEntry, client?: PoolClient): Promise<void> {
  const exec = client ?? pool

  const prev = await exec.query<{ row_hash: string }>(
    'SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1'
  )
  const prevHash = prev.rows[0]?.row_hash ?? null

  // Canonical serialization: fixed key order, so the same logical entry always hashes the
  // same way regardless of object literal ordering at the call site.
  const canonical = JSON.stringify([
    prevHash,
    entry.userId,
    entry.printedName,
    entry.action,
    entry.documentId ?? null,
    entry.revisionBefore ?? null,
    entry.revisionAfter ?? null,
    entry.oldValue ?? null,
    entry.newValue ?? null,
    entry.reason ?? null
  ])
  const rowHash = createHash('sha256').update(canonical).digest('hex')

  await exec.query(
    `INSERT INTO audit_log
       (user_id, printed_name, action, document_id, revision_before, revision_after,
        old_value, new_value, reason, prev_hash, row_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      entry.userId,
      entry.printedName,
      entry.action,
      entry.documentId ?? null,
      entry.revisionBefore ?? null,
      entry.revisionAfter ?? null,
      entry.oldValue == null ? null : JSON.stringify(entry.oldValue),
      entry.newValue == null ? null : JSON.stringify(entry.newValue),
      entry.reason ?? null,
      prevHash,
      rowHash
    ]
  )
}

export interface ChainVerification {
  ok: boolean
  checked: number
  brokenAtId: number | null
  detail: string
}

/**
 * Recompute the chain end to end. This is the control that actually demonstrates integrity
 * to an inspector, so it is a first-class feature rather than a test helper.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const rows = await pool.query<{
    id: string
    user_id: string | null
    printed_name: string
    action: string
    document_id: string | null
    revision_before: number | null
    revision_after: number | null
    old_value: unknown
    new_value: unknown
    reason: string | null
    prev_hash: string | null
    row_hash: string
  }>('SELECT * FROM audit_log ORDER BY id ASC')

  let expectedPrev: string | null = null
  for (const r of rows.rows) {
    if (r.prev_hash !== expectedPrev) {
      return {
        ok: false,
        checked: rows.rows.length,
        brokenAtId: Number(r.id),
        detail: `Row ${r.id} expected prev_hash ${expectedPrev ?? 'null'} but stored ${r.prev_hash ?? 'null'} — a preceding row was altered or removed.`
      }
    }
    const canonical: string = JSON.stringify([
      r.prev_hash,
      r.user_id,
      r.printed_name,
      r.action,
      r.document_id,
      r.revision_before,
      r.revision_after,
      r.old_value ?? null,
      r.new_value ?? null,
      r.reason
    ])
    const recomputed: string = createHash('sha256').update(canonical).digest('hex')
    if (recomputed !== r.row_hash) {
      return {
        ok: false,
        checked: rows.rows.length,
        brokenAtId: Number(r.id),
        detail: `Row ${r.id} contents do not match its stored hash — this row was altered.`
      }
    }
    expectedPrev = r.row_hash
  }

  return {
    ok: true,
    checked: rows.rows.length,
    brokenAtId: null,
    detail: `All ${rows.rows.length} audit records verified; chain intact.`
  }
}
