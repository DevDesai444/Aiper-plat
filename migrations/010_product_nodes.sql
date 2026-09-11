-- Migration 010 — product_nodes + node ↔ document linking (E3)
--
-- Lorenzo's satellite product tree. Each project's mission decomposes
-- into assemblies / subassemblies / components / parts hanging off one
-- self-referential product_nodes table (parent_node_id, project_id).
-- Kind is a CHECK-constrained text so a mission that treats components
-- and parts differently can, and one that treats them the same can
-- too — no rigid ordering enforced at the schema level (real trees are
-- messy).
--
-- Access rides the project's grants — nodes are NOT added to
-- aiper_subject. Every route reads aiper_effective_access(user,
-- 'project', projectId); if per-node grants become a real ask, we
-- widen the resolver in a follow-up migration (walk product_node →
-- project, mirroring document → folder → project). Audit rows are
-- forced by audit_log.subject_type being the aiper_subject enum: node
-- events audit against subjectType 'project', link events against
-- subjectType 'document' so a link surfaces on the doc's traceability.
--
-- product_node_documents is the traceability junction — a "test
-- report" for a component, a "design-spec" for an assembly, and (per
-- ECSS practice) a "requirement" doc for anything it verifies. UNIQUE
-- (node, doc, relation) lets the same doc be a design-spec AND a
-- sign-off on the same node (two links, two relations) without
-- duplication. relation stays a CHECK so extending the vocab is a
-- light migration, not a domain rewrite. Link rows are hard-deleted
-- (associations, not content); the node itself soft-deletes via
-- archived_at, consistent with folders/documents.
--
-- Column naming follows the locked repo convention: `relation` for
-- the link-type discriminator, and `created_by` / `created_at` for
-- the actor/timestamp on every table — including the link table —
-- so audit reads have one shape across the schema.

BEGIN;

CREATE TABLE product_nodes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_node_id uuid        REFERENCES product_nodes(id) ON DELETE CASCADE,
  kind           text        NOT NULL CHECK (kind IN ('assembly','subassembly','component','part')),
  name           text        NOT NULL,
  part_number    text,
  description    text,
  attributes     jsonb       NOT NULL DEFAULT '{}',
  created_by     uuid        NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  -- Trivial self-parent cycle caught at the schema level; deeper
  -- cycles (a→b→a) are handled by a recursive-CTE check in the
  -- move route (matches E2's folder-move pattern).
  CONSTRAINT product_nodes_no_self_parent
    CHECK (parent_node_id IS NULL OR parent_node_id <> id)
);

CREATE INDEX product_nodes_project_idx     ON product_nodes (project_id);
CREATE INDEX product_nodes_parent_idx      ON product_nodes (parent_node_id);
-- Cross-mission part-number lookup ("who else uses M-1234?") is a
-- realistic query. Partial index keeps it cheap for the many nodes
-- with no part number (assemblies, subassemblies).
CREATE INDEX product_nodes_part_number_idx ON product_nodes (part_number) WHERE part_number IS NOT NULL;

CREATE TABLE product_node_documents (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_node_id uuid        NOT NULL REFERENCES product_nodes(id) ON DELETE CASCADE,
  document_id     uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation        text        NOT NULL DEFAULT 'reference'
                    CHECK (relation IN ('reference','design-spec','test-report','sign-off','requirement')),
  created_by      uuid        NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_node_id, document_id, relation)
);

CREATE INDEX product_node_documents_node_idx ON product_node_documents (product_node_id);
CREATE INDEX product_node_documents_doc_idx  ON product_node_documents (document_id);

COMMIT;
