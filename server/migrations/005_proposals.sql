-- Migration 005 — change proposals with review.
--
-- Replaces pessimistic check-out with optimistic editing plus a review gate. Everyone edits
-- freely; saving records a PROPOSAL rather than writing the live document. A reviewer accepts
-- it (which creates the next revision), closes it, or comments. Nobody blocks anybody, and
-- nothing lands without a decision — which is the shape of a regulatory review anyway.
--
-- Locks are kept but are now advisory only ("Riya is editing this"), not a gate on saving.

BEGIN;

CREATE TYPE aiper_proposal_status AS ENUM ('open', 'accepted', 'closed');

CREATE TABLE proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id),
  author_id     uuid NOT NULL REFERENCES users(id),
  -- Revision this work started from. If the document has moved past it, the proposal needs
  -- re-checking before it can land.
  base_revision integer NOT NULL,
  content       jsonb NOT NULL,
  content_hash  text NOT NULL,
  summary       text,
  status        aiper_proposal_status NOT NULL DEFAULT 'open',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id),
  resolution_reason text,
  -- The revision created when this proposal was accepted.
  resulting_revision integer
);

-- One open proposal per person per document: saving again updates it rather than spawning a
-- second one, so reviewers see one entry per author instead of one per keystroke session.
CREATE UNIQUE INDEX proposals_one_open_per_author
  ON proposals (document_id, author_id) WHERE status = 'open';
CREATE INDEX proposals_document_idx ON proposals (document_id, status, updated_at DESC);

CREATE TABLE proposal_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposal_comments_idx ON proposal_comments (proposal_id, created_at);

COMMIT;
