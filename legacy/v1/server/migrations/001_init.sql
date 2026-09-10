-- Aiper schema, migration 001
--
-- Design notes that matter for 21 CFR Part 11:
--   * document_revisions and audit_log are APPEND-ONLY, enforced by triggers rather than
--     convention. 11.10(e) requires that record changes not obscure previously recorded
--     information; a table anyone can UPDATE does not satisfy that.
--   * audit_log is hash-chained (prev_hash -> row_hash) so tampering is detectable even by
--     someone with database access.
--   * All timestamps are server-side (now()). Client clocks are not trusted.
--   * Users are deactivated, never deleted — the audit trail references them permanently.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- append-only enforcement
CREATE OR REPLACE FUNCTION aiper_deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING HINT = 'Records are immutable for 21 CFR 11.10(e). Insert a new row instead.';
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------------------- identity
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  databricks_user_id  text UNIQUE NOT NULL,
  email               text UNIQUE NOT NULL,
  display_name        text NOT NULL,
  -- Deactivation, not deletion: 11.100(a) requires that an id is never reused or reassigned.
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz
);

-- Authority checks, 11.10(g). A user may hold several roles.
CREATE TYPE aiper_role AS ENUM ('author', 'reviewer', 'approver', 'admin');

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id),
  role        aiper_role NOT NULL,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- ------------------------------------------------------------------------------ documents
CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Path within the project tree. Identity is this id, NOT the path, so a rename does not
  -- orphan the revision history or the audit trail.
  path           text NOT NULL,
  title          text NOT NULL,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  current_revision integer NOT NULL DEFAULT 0,
  -- Soft delete only; regulated records are retained.
  archived_at    timestamptz,
  UNIQUE (path)
);

CREATE TABLE document_revisions (
  id             bigserial PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES documents(id),
  revision       integer NOT NULL,
  parent_revision integer,
  -- ProseMirror document JSON. This is the source of truth; .docx is an export format,
  -- because the .docx round-trip is lossy for tracked changes and comments.
  content        jsonb NOT NULL,
  content_hash   text NOT NULL,
  page_setup     jsonb NOT NULL,
  header         jsonb,
  footer         jsonb,
  author_id      uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision)
);
CREATE INDEX document_revisions_doc_idx ON document_revisions (document_id, revision DESC);

CREATE TRIGGER document_revisions_append_only
  BEFORE UPDATE OR DELETE ON document_revisions
  FOR EACH ROW EXECUTE FUNCTION aiper_deny_mutation();

-- ---------------------------------------------------------------------------------- locks
-- One lock per document. Leases expire so a crashed client cannot hold a document forever.
CREATE TABLE document_locks (
  document_id  uuid PRIMARY KEY REFERENCES documents(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

-- ------------------------------------------------------------------------------ comments
CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id),
  -- Matches the commentId attribute on the ProseMirror comment mark.
  mark_id      text NOT NULL,
  quoted_text  text NOT NULL,
  body         text NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id),
  UNIQUE (document_id, mark_id)
);

-- ---------------------------------------------------------------------------- signatures
-- 11.50 manifestation + 11.70 record binding. Signing covers a specific content_hash, so a
-- signature cannot be transferred to a different revision by ordinary means.
CREATE TYPE aiper_signature_meaning AS ENUM ('authored', 'reviewed', 'approved');

CREATE TABLE signatures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id),
  revision      integer NOT NULL,
  content_hash  text NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  printed_name  text NOT NULL,
  meaning       aiper_signature_meaning NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signatures_doc_idx ON signatures (document_id, revision);

CREATE TRIGGER signatures_append_only
  BEFORE UPDATE OR DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION aiper_deny_mutation();

-- ----------------------------------------------------------------------------- audit log
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  user_id         uuid REFERENCES users(id),
  -- Denormalized so the trail still reads correctly if a display name later changes.
  printed_name    text NOT NULL,
  action          text NOT NULL,
  document_id     uuid REFERENCES documents(id),
  revision_before integer,
  revision_after  integer,
  old_value       jsonb,
  new_value       jsonb,
  reason          text,
  -- Chain over the preceding row; computed in application code from a canonical
  -- serialization of this row's fields.
  prev_hash       text,
  row_hash        text NOT NULL
);
CREATE INDEX audit_log_doc_idx ON audit_log (document_id, occurred_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, occurred_at DESC);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION aiper_deny_mutation();

COMMIT;
