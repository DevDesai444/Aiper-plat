-- Migration 007: comments.
--
-- Fresh CREATE — comments is entirely E2's territory (E1's PR-3 did not
-- touch it). Mirrors the Comment interface in
-- packages/aiper-shared/src/types/hierarchy.ts.
--
-- Length caps live in CommentSchema (packages/aiper-shared/src/schemas/
-- hierarchy.ts) and are enforced at the API boundary via Zod, not by CHECK
-- constraints here. Same rationale as E1's other domain tables: keep DB
-- constraints to invariants that must not vary (FKs, NOT NULL, referential
-- shape) and let the schema layer own value-range checks so we don't
-- migrate the DB every time a cap changes.
--
-- author_display_name is denormalized at write time so the Navigator's
-- comment feed doesn't need a users join per row. On a user renaming their
-- display name we take the "old-name-in-old-comments" behaviour (matches
-- Slack / Linear / GitHub); if we change our mind the fix is an UPDATE
-- pass plus a nightly reconciliation job, not a schema change.

CREATE TABLE comments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  mark_id             TEXT        NOT NULL,
  quoted_text         TEXT,
  body                TEXT        NOT NULL,
  author_id           UUID        NOT NULL REFERENCES users(id),
  author_display_name TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  resolved_by         UUID        REFERENCES users(id)
);

CREATE INDEX comments_document_idx ON comments (document_id);
