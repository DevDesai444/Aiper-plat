/**
 * Week-4 interface freeze for the document-snapshot / save-checkpoint
 * layer. Consumed by E6's Save-timeline UI and by anyone reading a
 * document's history — do not fork; change here and re-publish.
 *
 * A snapshot row is a frozen Yjs state captured at the moment of a Save.
 * The bytes themselves live on the server as BYTEA and are NEVER inlined
 * into JSON. Clients fetch them over the binary state endpoint
 * (GET /api/v1/documents/:did/snapshots/:sid/state → application/octet-stream)
 * and feed them into Yjs's applyUpdate() to reopen the document at that
 * point in time.
 *
 * Companion Zod schemas mirror these types in ../schemas/snapshots.ts;
 * edit both files in the same PR.
 */

/**
 * Why a snapshot exists.
 *   auto       — periodic durability write from the WS server, no user
 *                intent. NOT audited (would flood /verify with 2880
 *                "nothing meaningful" rows per document per day).
 *   checkpoint — explicit user Save, optionally with a reason/label.
 *                Written together with an audit_log row in one txn.
 *   release    — same as checkpoint plus a project-lifecycle meaning
 *                (a shipped baseline). Also audited.
 */
export type SnapshotReason = 'auto' | 'checkpoint' | 'release'

/**
 * A single snapshot as returned by the history endpoint. `savedBy` is a
 * users.id; a display name is left for the read route to join in when
 * humans need to see the timeline. `label` is the short user-provided
 * name shown in the Save timeline; null for auto-snapshots and for
 * checkpoints where the user did not name their Save.
 *
 * The Yjs bytes are deliberately absent — see the file header for how
 * the binary state endpoint returns them.
 */
export interface DocumentSnapshot {
  /** uuid */
  id: string
  /** uuid — documents.id */
  documentId: string
  /** uuid — users.id who triggered the save */
  savedBy: string
  /** ISO 8601 with offset (matches PostgreSQL timestamptz JSON serialisation). */
  savedAt: string
  reason: SnapshotReason
  label: string | null
}

/**
 * Response shape of GET /api/v1/documents/:did/history. Ordered by
 * saved_at DESC (newest first) — the same order the DB index carries.
 */
export interface SnapshotList {
  snapshots: DocumentSnapshot[]
}

/**
 * Request body for POST /api/v1/documents/:did/save. Both fields are
 * optional; a Save with an empty body is a valid "checkpoint here, no
 * commentary" gesture and lands with reason='checkpoint', label=null.
 *
 * `reason` is the free-text "why" carried into audit_log.reason so the
 * regulator's log entry names the operator's intent.
 * `label` is the short human-visible name shown in the Save timeline UI.
 */
export interface SaveRequest {
  reason?: string | null
  label?: string | null
}
