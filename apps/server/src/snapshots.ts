import type pg from 'pg'
import type { DocumentSnapshot, SnapshotReason } from '@aiper/shared/types'
import { writeAudit } from './audit.js'

/**
 * Options handed to saveSnapshot when writing a new checkpoint.
 *
 *   reason      — matches SnapshotReasonSchema. 'auto' is silent (no
 *                 audit_log row); 'checkpoint' and 'release' always
 *                 write one. This is the durability-vs-intent split
 *                 the lead approved in the kickoff review.
 *   label       — short human-visible name shown in the Save timeline.
 *   userReason  — free-text "why" carried into audit_log.reason. Only
 *                 sensible on 'checkpoint' / 'release'; ignored for
 *                 'auto' since no audit row is written.
 *   actor       — the user driving the save. id + printedName are
 *                 audit_log columns; keeping printedName here (rather
 *                 than joining on users at write time) preserves the
 *                 name-at-the-moment-of-write invariant audit_log needs.
 */
export interface SaveOptions {
  reason: SnapshotReason
  label: string | null
  userReason: string | null
  actor: { id: string; printedName: string }
}

/**
 * Serialise a snapshot row to the DocumentSnapshot shape callers see on
 * the wire. Kept as one function so the two writers below (route + auto)
 * and PR-5's history list share it.
 */
function rowToSnapshot(row: {
  id: string
  documentId: string
  savedBy: string
  savedAt: string
  reason: SnapshotReason
  label: string | null
}): DocumentSnapshot {
  return row
}

/**
 * Freeze the current Yjs state for `documentId` as one row on
 * document_snapshots, optionally audit the event, and point the
 * document at the new snapshot — all inside one transaction so a
 * partial failure leaves nothing behind.
 *
 * Callers are responsible for the access check (editor+ on the
 * document) and for supplying the Yjs bytes. The bytes come from the
 * client body in PR-3; PR-4 will replace that with the server's
 * in-memory Y.Doc for a room.
 *
 * `opts.reason === 'auto'` skips the audit write — durability writes
 * are not user intent (kickoff answer to Q2). Every other reason
 * writes exactly one audit_log row via writeAudit on the same
 * connection, so the audit chain and the snapshot commit atomically
 * or both roll back.
 */
export async function saveSnapshot(
  pool: pg.Pool,
  documentId: string,
  yjsState: Buffer,
  opts: SaveOptions,
): Promise<DocumentSnapshot> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // to_char yields ISO 8601 with a Z suffix, matching IsoDateTimeSchema
    // (z.string().datetime({ offset: true })) used elsewhere in the API.
    const inserted = await client.query<{
      id: string
      documentId: string
      savedBy: string
      savedAt: string
      reason: SnapshotReason
      label: string | null
    }>(
      `INSERT INTO document_snapshots
         (document_id, yjs_state, reason, label, saved_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id,
                 document_id AS "documentId",
                 saved_by    AS "savedBy",
                 to_char(saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "savedAt",
                 reason,
                 label`,
      [documentId, yjsState, opts.reason, opts.label, opts.actor.id],
    )
    const snapshot = inserted.rows[0]!

    if (opts.reason !== 'auto') {
      // Same connection as the INSERT — writeAudit reads prev_hash and
      // writes the new row within this transaction so a concurrent audit
      // writer cannot slip a row between them.
      await writeAudit(client, {
        userId: opts.actor.id,
        printedName: opts.actor.printedName,
        action: 'document.saved',
        subjectType: 'document',
        subjectId: documentId,
        newValue: { snapshotId: snapshot.id, label: opts.label },
        reason: opts.userReason,
      })
    }

    // updated_at bumps so the document card in E6's Navigator surfaces
    // recent activity without a separate query on snapshots.
    await client.query(
      `UPDATE documents
          SET current_snapshot_id = $1,
              updated_at          = now()
        WHERE id = $2`,
      [snapshot.id, documentId],
    )

    await client.query('COMMIT')
    return rowToSnapshot(snapshot)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Fetch the raw Yjs bytes for one snapshot, guarded by the URL invariant
 * that the caller nominated the correct document id. Returns null when
 * the snapshot does not exist OR the snapshot belongs to a different
 * document than the URL claims — both cases collapse to the same 404
 * from the route so URL leaks cannot be replayed to gain access.
 */
export async function readSnapshotState(
  pool: pg.Pool,
  documentId: string,
  snapshotId: string,
): Promise<Buffer | null> {
  const row = await pool.query<{ yjs_state: Buffer }>(
    `SELECT yjs_state FROM document_snapshots
      WHERE id = $1 AND document_id = $2`,
    [snapshotId, documentId],
  )
  return row.rows[0]?.yjs_state ?? null
}
