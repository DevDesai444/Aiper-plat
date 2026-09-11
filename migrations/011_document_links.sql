-- Migration 011 — document↔document traceability links.
--
-- Directed link from one document to another with a semantic `relation`.
-- Doc↔doc lives here; doc↔node (product-tree side) lives in E3's 010
-- (product_node_documents). The two tables share column conventions
-- (`relation`, `created_by`, `created_at`, CHECK-constrained TEXT for the
-- relation vocab) so a reader who has read one file recognises the other.
--
-- Vocabulary (five values, disjoint from E3's doc↔node set):
--   verifies       — test / report doc verifies a spec or design
--   references     — weak "see also"; no stronger semantics claimed
--   derives-from   — this doc is built on top of another
--   supersedes     — this doc replaces another (historical old)
--   conflicts-with — explicit contradiction flag (rework signal)
-- Extending: ALTER TABLE document_links DROP CONSTRAINT ... then re-ADD
-- CONSTRAINT with the wider IN-list in a follow-up migration.
--
-- Cross-project links are permitted at the DB level. The API layer gates
-- create-time visibility (viewer+ on target); the read layer filters
-- rows whose counterpart the caller can no longer see. Doc↔doc references
-- are cross-mission on purpose (shared ICDs, requirements standards);
-- doc↔node stays same-project (E3's structural containment invariant).

BEGIN;

CREATE TABLE document_links (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation           text        NOT NULL
                                 CHECK (relation IN (
                                   'verifies',
                                   'references',
                                   'derives-from',
                                   'supersedes',
                                   'conflicts-with'
                                 )),
  created_by         uuid        NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Self-links carry no traceability meaning and would be a UI trap. The
  -- API layer refuses these with a 400 for a nicer message; the CHECK is
  -- a belt-and-braces defense for direct SQL.
  CONSTRAINT document_links_no_self_link CHECK (source_document_id <> target_document_id),

  -- The same (source, target, relation) triple exists at most once.
  -- Different relations between the same pair are legal (Doc A can both
  -- derive-from AND supersede Doc B — unusual but semantically valid).
  UNIQUE (source_document_id, target_document_id, relation)
);

-- Reverse-lookup ("what verifies this?") is a first-class read. Index
-- target so the incoming-links query is a range scan; the source column
-- is already covered by the leading edge of the UNIQUE (source, target,
-- relation) constraint's index.
CREATE INDEX document_links_target_idx ON document_links (target_document_id);

COMMIT;
