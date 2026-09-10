-- Migration 005 — audit_log
--
-- Ports v1's audit chain (legacy/v1/server/migrations/001_init.sql +
-- 002_truncate_guard.sql) into the v2 shape:
--
--   * document_id (v1) becomes subject_type + subject_id, matching the
--     generic access model — an audit row can now describe a change to
--     a project, folder, OR document without a separate ref column each.
--   * user_id is NOT NULL. v1 allowed system events without a user; v2
--     always requires an authenticated actor (Supabase JWT).
--
-- The three protections combined:
--
--   1. Row-level BEFORE UPDATE OR DELETE trigger aiper_deny_mutation
--      blocks the ordinary path.
--   2. Statement-level BEFORE TRUNCATE trigger aiper_deny_truncate
--      closes the TRUNCATE loophole (row-level triggers do not fire on
--      TRUNCATE — a whole table's worth of rows silently vanished once
--      in v1 before this trigger existed).
--   3. Every row carries prev_hash + row_hash — a superuser CAN disable
--      the triggers, but they cannot alter a row without breaking the
--      chain from that point on, which verifyAuditChain will report.
--      Prevention alone is not achievable inside the database; detection
--      is what an inspector can be shown.

BEGIN;

CREATE TABLE audit_log (
  id              bigserial   PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  user_id         uuid        NOT NULL REFERENCES users(id),
  printed_name    text        NOT NULL,   -- denormalized so a rename never rewrites history
  action          text        NOT NULL,
  subject_type    aiper_subject NOT NULL,
  subject_id      uuid        NOT NULL,
  revision_before bigint,
  revision_after  bigint,
  old_value       jsonb,
  new_value       jsonb,
  reason          text,
  prev_hash       text,                   -- first row is NULL
  row_hash        text        NOT NULL
);

CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_log_user_idx    ON audit_log (user_id, occurred_at DESC);

-- ---------------------------------------------------------------- guard functions
-- Ported verbatim from legacy/v1/server/migrations/001_init.sql lines 17-22
-- (aiper_deny_mutation) and 002_truncate_guard.sql lines 17-22
-- (aiper_deny_truncate). Kept as separate functions so future append-only
-- tables (e.g. an eventual signatures table) can attach the same triggers.

CREATE OR REPLACE FUNCTION aiper_deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING HINT = 'Insert a new row instead — audit records are immutable.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aiper_deny_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: TRUNCATE is not permitted', TG_TABLE_NAME
    USING HINT = 'Audit records are retained.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION aiper_deny_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION aiper_deny_truncate();

COMMIT;
