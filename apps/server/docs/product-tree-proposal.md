# Product-tree backend — design proposal

**Author:** E3 (DevDesai-444)
**Status:** Proposal, not yet built. Awaiting sign-off before writing the migration or routes.

Lorenzo's core ask — the satellite product tree with document traceability. This file is the schema + API surface I'm proposing; when we've aligned, I'll ship migration `010`, then reads, then writes as separate PRs.

---

## 1. Node model — single self-referential `product_nodes` table

Recommended. One table with `parent_node_id` and `project_id`. Matches how `documents` / `folders` / `projects` each live in one table with a parent pointer, and it keeps the highest-wins access resolver (`aiper_effective_access`) unchanged — see §3.

Four kinds, all in the same table, discriminated by a `kind text CHECK` column:

| kind | typical use |
|---|---|
| `assembly` | Top-level or nested group ("Payload", "Bus") |
| `subassembly` | Nested group within an assembly ("Optical Bench Assembly") |
| `component` | Functional unit ("Detector") |
| `part` | Physical catalogue SKU ("Screw M-6-32", "Lens M-1234") |

**Component vs part** — some customers use them interchangeably. Keeping both lets a mission separate a functional block ("Detector") from the specific SKU ("Detector M-5678, s/n 42"). The tree can contain either or both.

Not enforcing "component/part are leaves" in the DB — enforce in the route (matching how `folders_no_self_parent` covers the trivial case at the schema level and route code covers deeper cycles). Cheap to relax later.

### Alternative I rejected

Separate tables per kind (`assemblies`, `subassemblies`, `components`, `parts`). Rejected because:
- FK-into-parent needs to work across kinds (a component can hang under a subassembly OR directly under an assembly), which forces a polymorphic association — worse than a single-table CHECK.
- The resolver would need four new subject_types instead of one, or none.
- Every SELECT that walks the tree becomes a `UNION ALL`.

---

## 2. Attributes — JSONB bag, not fixed columns

Recommended. Common columns first-class so they stay indexable; the long tail rides in a `jsonb` column named `attributes`.

**First-class columns:** `name`, `part_number`, `description`. These are what a user searches / sorts / filters on almost every open. `part_number` gets its own partial index (`WHERE part_number IS NOT NULL`) so cross-mission lookup by part is a range scan, not a seq scan.

**JSONB `attributes` bag** for everything else: `mass_kg`, `power_w`, `supplier`, `trl`, `radiation_hardened`, `datasheet_url`, mission-specific fields the operator invents mid-program. Reasons:

1. Real satellite BOMs have 20-40+ attributes and the exact list varies per program. Fixed columns would either grow linearly (schema churn every customer) or force a common denominator that fits nobody.
2. Postgres JSONB is queryable — GIN indexes on `attributes` when we need typed filters ("mass_kg > 5") ship later without a schema break.
3. The read shape is `Record<string, unknown>` on the wire; the frontend renders a definition-list. No typed accessor.

**Alternative I rejected:** a normalised `product_node_attributes` side-table with `(node_id, key, value)`. Better for typed queries at scale, but overkill for MVP — we'd bake it in from day one and pay the join cost on every tree read. Easier to migrate a heavily-queried key OUT of JSONB when the need appears (add a first-class column + backfill).

---

## 3. Permissions — inherit from project, no new `aiper_subject`

**Recommended: nodes ride the project's grants.** Every route runs `aiper_effective_access(userId, 'project', projectId)`. No changes to the resolver, no new grant rows.

- `viewer+` on the project = read the whole tree
- `editor+` on the project = create / update / move / delete nodes
- No sub-tree-level access ("edit only this subassembly")

**Trade-off:** we can't grant "read the payload subtree only" without adding `product_node` to `aiper_subject` and teaching the resolver to walk `product_node → project`. That's the same shape as the document → folder → project walk E1 already established, so it's cheap to add later. Ship the simpler version for MVP.

`writeAudit` calls still land against `subjectType: 'project'` — audit reads the audit log by subject, and tying node events to the project keeps every event about a mission in one bucket. `action` is where we distinguish: `product-node.created`, `product-node.updated`, `product-node.moved`, `product-node.archived`, `product-node.document-linked`, `product-node.document-unlinked`.

---

## 4. Document ↔ node linking — a typed junction table

This is what makes the tree useful for traceability. Opening "Detector M-5678" surfaces the design spec, the test report, the sign-off; opening a test report surfaces the components under test.

```sql
CREATE TABLE product_node_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_node_id uuid NOT NULL REFERENCES product_nodes(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation        text NOT NULL DEFAULT 'reference'
                    CHECK (relation IN ('reference','design-spec','test-report','sign-off')),
  linked_by       uuid NOT NULL REFERENCES users(id),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_node_id, document_id, relation)
);
CREATE INDEX product_node_documents_node_idx ON product_node_documents (product_node_id);
CREATE INDEX product_node_documents_doc_idx  ON product_node_documents (document_id);
```

Both FKs `ON DELETE CASCADE` — a link's whole reason for existing disappears when either endpoint does.

`UNIQUE (product_node_id, document_id, relation)` allows the same doc as a `design-spec` AND a `sign-off` on the same node (two links, different relations), which was a real case in v1.

### Access rules for links

- **Create a link:** `editor+` on the node's project AND `viewer+` on the target document. You cannot attach a doc you cannot see.
- **Read a link:** `viewer+` on the node's project. The link is a pointer; whether the caller can open the linked doc is enforced when they hit that doc's route.
- **Delete a link:** `editor+` on the node's project.

The doc-side access check runs via `aiper_effective_access(userId, 'document', documentId)` at link-create time only. We do not re-check on reads (the target doc's own routes gate that).

### Overlap with E2's cross-document links — flag

E2 is designing doc↔doc references (a specification citing another specification, per Lorenzo's mention). Zero conceptual overlap with node↔doc:

- doc↔doc = "this document references that document" (semantic reference)
- node↔doc = "this document describes this physical part" (attribution)

Different tables, different relation vocabularies, different UI surfaces. But the **pattern** is similar (junction table with a `relation` type + `linked_by`/`linked_at` audit stamp). To keep the two coherent I'd want to align on:

1. **Table naming.** `product_node_documents` vs whatever E2 picks (`document_references`? `document_links`?). Fine to diverge; naming stays clear because the subjects are different.
2. **`relation` enum shape.** Mine is `('reference','design-spec','test-report','sign-off')`. E2's will be different; not conflicting, but keep the field NAME `relation` and the CHECK style the same so audit reads are uniform.
3. **`linked_by`/`linked_at` columns** — same names on both tables so the audit log's shape is consistent.

I am **not** designing doc↔doc here. E2 owns that.

---

## 5. API surface

### Reads (viewer+ on project, `404` for existence-leak on both non-existent and no-grant)

- `GET /api/v1/projects/:pid/product-tree`
  → `ProductTreeResponse { project: Project; nodes: ProductNode[] }`
  DFS preorder, siblings ordered by `lower(name)`, matching E2's `ProjectFolderTree` convention. `archived_at IS NULL` filter unless `?includeArchived=true`.

- `GET /api/v1/product-nodes/:nid` → `ProductNode` (with `myRole` populated from project)

- `GET /api/v1/product-nodes/:nid/children` → direct children only, for lazy-tree UI

- `GET /api/v1/product-nodes/:nid/documents` → `{ items: NodeDocumentLink[] }`

- `GET /api/v1/documents/:did/nodes` → `{ items: NodeDocumentLink[] }` (reverse lookup — "which parts does this doc describe?")

### Writes (editor+ on project)

- `POST   /api/v1/projects/:pid/product-nodes` — create root node (`parent_node_id: null`)
- `POST   /api/v1/product-nodes/:nid/children` — create child
- `PATCH  /api/v1/product-nodes/:nid` — update fields (name, kind, part_number, description, attributes)
- `POST   /api/v1/product-nodes/:nid/move` — reparent; body `{ parentNodeId: string | null }`. Separate endpoint so the deeper-cycle check lives in one place.
- `DELETE /api/v1/product-nodes/:nid` — soft-delete (`archived_at`), consistent with E2's folders/documents. Recursive soft-cascade to descendants.
- `POST   /api/v1/product-nodes/:nid/documents` — attach doc; body `{ documentId, relation }`. Enforces viewer+ on target doc at create time.
- `DELETE /api/v1/product-nodes/:nid/documents/:did?relation=<r>` — detach one link (or all links to `:did` if `relation` omitted)

Every write hits `writeAudit` on the same transaction the domain write runs on, matching how E3's save flow already patterns it.

### `@aiper/shared` types + Zod

New file `packages/aiper-shared/src/types/product-tree.ts`, mirrored under `schemas/`. Names lock the wire contract for E6/E7:

```ts
export type ProductNodeKind = 'assembly' | 'subassembly' | 'component' | 'part'

export interface ProductNode {
  id: string
  projectId: string
  parentNodeId: string | null
  kind: ProductNodeKind
  name: string
  partNumber: string | null
  description: string | null
  attributes: Record<string, unknown>
  createdBy: string
  createdAt: string   // ISO 8601 with offset
  updatedAt: string
  archivedAt: string | null
  myRole: AiperRole | null   // inherited from project
}

export interface ProductTreeResponse {
  project: Project      // reuse E2's Project
  nodes: ProductNode[]  // DFS preorder, siblings by lower(name)
}

export type NodeDocumentRelation = 'reference' | 'design-spec' | 'test-report' | 'sign-off'

export interface NodeDocumentLink {
  id: string
  productNodeId: string
  documentId: string
  relation: NodeDocumentRelation
  linkedBy: string
  linkedAt: string
}

export interface CreateProductNodeRequest {
  parentNodeId: string | null
  kind: ProductNodeKind
  name: string
  partNumber?: string | null
  description?: string | null
  attributes?: Record<string, unknown>
}

export interface UpdateProductNodeRequest {
  kind?: ProductNodeKind
  name?: string
  partNumber?: string | null
  description?: string | null
  attributes?: Record<string, unknown>
}

export interface MoveProductNodeRequest {
  parentNodeId: string | null
}

export interface LinkDocumentRequest {
  documentId: string
  relation: NodeDocumentRelation
}
```

---

## 6. Migration `010` — rough sketch

Main tip when this proposal was drafted has `009_project_documents.sql`. Next slot is `010`.

```sql
-- Migration 010 — product_nodes + node ↔ document linking (E3)
--
-- Lorenzo's satellite product tree. Nodes decompose a project into
-- assemblies / subassemblies / components / parts; each node can
-- attach documents (design specs, test reports, sign-offs) for
-- traceability.
--
-- Access rides the project's grants — nodes are NOT added to the
-- aiper_subject enum. If per-node grants become a real ask, the
-- resolver walk product_node → project mirrors document → folder →
-- project and goes in a follow-up migration.
--
-- Sits on top of E1's 004 (aiper_effective_access, unchanged here)
-- and E2's 006 (documents domain columns — no schema conflict).

BEGIN;

CREATE TABLE product_nodes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_node_id uuid REFERENCES product_nodes(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('assembly','subassembly','component','part')),
  name           text NOT NULL,
  part_number    text,
  description    text,
  attributes     jsonb NOT NULL DEFAULT '{}',
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT product_nodes_no_self_parent
    CHECK (parent_node_id IS NULL OR parent_node_id <> id)
);

CREATE INDEX product_nodes_project_idx     ON product_nodes (project_id);
CREATE INDEX product_nodes_parent_idx      ON product_nodes (parent_node_id);
CREATE INDEX product_nodes_part_number_idx ON product_nodes (part_number) WHERE part_number IS NOT NULL;

CREATE TABLE product_node_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_node_id uuid NOT NULL REFERENCES product_nodes(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation        text NOT NULL DEFAULT 'reference'
                    CHECK (relation IN ('reference','design-spec','test-report','sign-off')),
  linked_by       uuid NOT NULL REFERENCES users(id),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_node_id, document_id, relation)
);

CREATE INDEX product_node_documents_node_idx ON product_node_documents (product_node_id);
CREATE INDEX product_node_documents_doc_idx  ON product_node_documents (document_id);

COMMIT;
```

No new trigger for creator-auto-owns — nodes aren't in `aiper_subject`, so `aiper_creator_auto_owns` doesn't need to fire.

---

## 7. Open decisions I need your call on

1. **Access model** — Option B (inherit from project) as recommended, or wire per-node grants (product_node → project resolver walk) now? Adding it later is straightforward but the interface contract on `ProductNode.myRole` would change (would still be `AiperRole | null` but the value could differ from the project's role).
2. **Kind → leaf enforcement** — do `component` / `part` need a DB-level "no children" guard? I'd say route-only for now. Say the word if you want it in the CHECK constraint.
3. **Alternative designs / trade studies** — I'm assuming ONE tree per project (`product_nodes` just filter by `project_id`). If a mission needs concurrent reference designs (Design A vs Design B trade study), we need a `product_trees` header table with a `is_active_baseline` flag. Fine to defer — say the word.
4. **Compatibility check** — Lorenzo's intro also mentioned compatibility. Assume that's a follow-up phase touching these same tables with a `product_node_compatibility_rules` sibling. Nothing in this proposal blocks it.
5. **Relation vocab on `product_node_documents.relation`** — I've listed `('reference','design-spec','test-report','sign-off')`. Any additions before we lock the CHECK? Once shipped, extending the enum is a light migration.
6. **`archived_at` vs hard delete on links** — I've modelled links as hard-delete (no `archived_at`). A detach is a small action; keeping a history of every detach is not obviously useful. If regulators want an "attachment history", the `audit_log` rows (`product-node.document-linked` / `product-node.document-unlinked`) already carry that. Confirm.

Ping me with answers (or "sensible defaults, ship it") and I'll open the migration PR first, then read routes, then writes — same cadence as PR-1..5.
