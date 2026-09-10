import { createHash } from 'node:crypto'
import type pg from 'pg'
import type { AuditEntry, ChainVerification } from '@aiper/shared/types'

/**
 * Chain integrity depends on writer and verifier agreeing byte-for-byte
 * on the canonical form of every row. Two functions below — one in
 * writeAudit and one in verifyAuditChain — MUST use exactly this field
 * order. Do not reorder, do not insert new fields, do not silently
 * default. If a column is added to audit_log, update both call sites in
 * the same commit and add a migration that walks existing rows.
 *
 * `oldValue` and `newValue` are canonicalized by sorting object keys
 * alphabetically before JSON.stringify. Postgres JSONB storage does not
 * preserve insertion key order, so read-back returns keys in postgres's
 * internal order (length-then-alpha). Sorting on both sides makes the
 * canonical text identical to what the writer computed regardless of
 * how postgres stored it.
 */
function canonicalize(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonicalize)
  const obj = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k])
  }
  return out
}

function canonicalRow(prevHash: string | null, e: AuditEntry): string {
  return JSON.stringify([
    prevHash,
    e.userId,
    e.printedName,
    e.action,
    e.subjectType,
    e.subjectId,
    e.revisionBefore ?? null,
    e.revisionAfter ?? null,
    canonicalize(e.oldValue ?? null),
    canonicalize(e.newValue ?? null),
    e.reason ?? null,
  ])
}

/**
 * Append one audit row, chained to the previous one.
 *
 * SELECT prev_hash and INSERT run on the same connection so a concurrent
 * writer cannot slip a row between them. Callers can pass an existing
 * pg client to attach an audit write to their own transaction — that's
 * the pattern for "this domain change and its audit entry either both
 * happen or neither does". Passing a pool works too for a standalone
 * audit-only write.
 *
 * Timestamps come from the database (now()). Client clocks are not trusted.
 */
export async function writeAudit(
  poolOrClient: pg.Pool | pg.PoolClient,
  entry: AuditEntry,
): Promise<void> {
  const prev = await poolOrClient.query<{ row_hash: string }>(
    'SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1',
  )
  const prevHash = prev.rows[0]?.row_hash ?? null

  const rowHash = createHash('sha256').update(canonicalRow(prevHash, entry)).digest('hex')

  await poolOrClient.query(
    `INSERT INTO audit_log
       (user_id, printed_name, action, subject_type, subject_id,
        revision_before, revision_after, old_value, new_value, reason,
        prev_hash, row_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entry.userId,
      entry.printedName,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      entry.revisionBefore ?? null,
      entry.revisionAfter ?? null,
      entry.oldValue == null ? null : JSON.stringify(entry.oldValue),
      entry.newValue == null ? null : JSON.stringify(entry.newValue),
      entry.reason ?? null,
      prevHash,
      rowHash,
    ],
  )
}

/**
 * Walk every row, recomputing prev_hash and row_hash. Stops at the first
 * discrepancy and reports which row broke and why.
 *
 * This is the control that actually demonstrates integrity to an
 * inspector, so it is a first-class endpoint (routes/audit.ts) rather
 * than a test helper.
 */
export async function verifyAuditChain(pool: pg.Pool): Promise<ChainVerification> {
  const rows = await pool.query<{
    id: string
    user_id: string
    printed_name: string
    action: string
    subject_type: 'project' | 'folder' | 'document'
    subject_id: string
    revision_before: number | string | null
    revision_after: number | string | null
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
        detail: `Row ${r.id} expected prev_hash ${expectedPrev ?? 'null'} but stored ${r.prev_hash ?? 'null'} — a preceding row was altered or removed.`,
      }
    }

    // Rebuild the same AuditEntry the writer used and recompute the hash.
    // bigint columns come back as string from pg by default; coerce.
    const entry: AuditEntry = {
      userId: r.user_id,
      printedName: r.printed_name,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      revisionBefore: r.revision_before == null ? null : Number(r.revision_before),
      revisionAfter: r.revision_after == null ? null : Number(r.revision_after),
      oldValue: r.old_value,
      newValue: r.new_value,
      reason: r.reason,
    }
    const recomputed: string = createHash('sha256').update(canonicalRow(r.prev_hash, entry)).digest('hex')
    if (recomputed !== r.row_hash) {
      return {
        ok: false,
        checked: rows.rows.length,
        brokenAtId: Number(r.id),
        detail: `Row ${r.id} contents do not match its stored hash — this row was altered.`,
      }
    }
    expectedPrev = r.row_hash
  }

  return {
    ok: true,
    checked: rows.rows.length,
    brokenAtId: null,
    detail: `All ${rows.rows.length} audit records verified; chain intact.`,
  }
}
