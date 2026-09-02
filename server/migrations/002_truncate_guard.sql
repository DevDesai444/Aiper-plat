-- Migration 002 — close the TRUNCATE hole in the append-only guarantee.
--
-- The row-level BEFORE UPDATE OR DELETE triggers from 001 do not fire on TRUNCATE, so a
-- single TRUNCATE emptied audit_log despite the table being nominally append-only. Verified
-- against this database before fixing. TRUNCATE needs its own statement-level trigger.
--
-- Layers of defence, and their honest limits:
--   1. These triggers stop ordinary UPDATE / DELETE / TRUNCATE.
--   2. The application connects as a role without table-owner rights, so it cannot disable
--      them (granted in 003, once the service principal exists).
--   3. The audit_log hash chain makes tampering DETECTABLE even by someone who can disable
--      triggers — a superuser always can. Prevention alone is not achievable inside the
--      database; detection is the backstop, and is what an inspector can be shown.

BEGIN;

CREATE OR REPLACE FUNCTION aiper_deny_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: TRUNCATE is not permitted', TG_TABLE_NAME
    USING HINT = 'Records are retained for 21 CFR 11.10(e) and 11.10(c).';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION aiper_deny_truncate();

CREATE TRIGGER document_revisions_no_truncate
  BEFORE TRUNCATE ON document_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION aiper_deny_truncate();

CREATE TRIGGER signatures_no_truncate
  BEFORE TRUNCATE ON signatures
  FOR EACH STATEMENT EXECUTE FUNCTION aiper_deny_truncate();

COMMIT;
