-- Migration 008 — document_snapshots (E3)
--
-- Every Save on an authored document — user checkpoint or the server's
-- periodic auto-save — freezes the current Yjs state as a row here. The
-- Save-timeline UI reads this table; Phase 4 traceability queries walk
-- it for authorship of a given text range.
--
-- Sits on top of E2's migration 006, which added the FK-less
-- documents.current_snapshot_id column so this table could close the FK
-- loop from either direction.
--
--   document_id → documents(id) ON DELETE CASCADE
--     Snapshots go with their document when it is hard-deleted. Under
--     soft-delete (documents.archived_at, added in 006) they stay put.
--
--   saved_by → users(id) (no delete action)
--     A user cannot be hard-deleted while any of their history rows
--     remain; that is a policy match with audit_log.user_id.
--
--   reason CHECK
--     Mirrors SnapshotReasonSchema in packages/aiper-shared/src/schemas/
--     snapshots.ts. Both sides must move together — the interface is
--     frozen.
--
-- Reverse FK: documents.current_snapshot_id → document_snapshots(id)
-- ON DELETE SET NULL. If a snapshot is ever pruned (a future admin
-- path — the table is otherwise append-only under normal ops), the
-- document's pointer clears rather than dangling.

CREATE TABLE document_snapshots (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  yjs_state   bytea       NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('auto', 'checkpoint', 'release')),
  label       text,
  saved_by    uuid        NOT NULL REFERENCES users(id),
  saved_at    timestamptz NOT NULL DEFAULT now()
);

-- Timeline read pattern is "give me the last N snapshots for this document";
-- DESC on saved_at lines up with the index for a straight range scan.
CREATE INDEX document_snapshots_doc_saved_idx
  ON document_snapshots (document_id, saved_at DESC);

-- Close the FK loop E2 left open in 006.
ALTER TABLE documents
  ADD CONSTRAINT documents_current_snapshot_fk
  FOREIGN KEY (current_snapshot_id)
  REFERENCES document_snapshots(id)
  ON DELETE SET NULL;
