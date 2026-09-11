/**
 * Wk-11 interface freeze for the product-tree layer — Lorenzo's
 * satellite decomposition (assemblies → subassemblies → components →
 * parts) plus the doc↔node link that makes the tree traceable.
 *
 * Publishing these shapes at read-route time (rather than waiting for
 * the writes) unblocks the frontend to render the tree UI against
 * real types while E3's write PR is still in flight.
 *
 * Companion Zod schemas mirror these types 1:1 in
 * ../schemas/product-tree.ts. If a field changes, update both files
 * in the same PR — the schema is what routes validate their responses
 * against, and drift would let a wrong-shape row leak.
 */

import type { AiperRole } from './index.js'
import type { Project } from './hierarchy.js'

/**
 * Node kinds — assembly / subassembly / component / part. Real
 * satellite BOMs use all four with fuzzy boundaries ("component" and
 * "part" often mean the same thing depending on org), so we accept
 * every value and let the customer decide granularity. The route
 * layer does not enforce "component/part is a leaf"; a mission can
 * hang a sub-part off a part if that's what they need.
 */
export type ProductNodeKind = 'assembly' | 'subassembly' | 'component' | 'part'

/**
 * How a document relates to a product node. Matches the CHECK in
 * migration 010 exactly. `requirement` is on the list because
 * requirement→verification is the backbone of ECSS traceability.
 * Extending the vocab is a light CHECK migration.
 */
export type NodeDocumentRelation =
  | 'reference'
  | 'design-spec'
  | 'test-report'
  | 'sign-off'
  | 'requirement'

/**
 * One node in a project's product tree. `parentNodeId` is null for a
 * root of the tree; a project can have multiple roots (e.g. Payload
 * and Bus each hanging directly off the project). `myRole` inherits
 * from the parent project — nodes have no per-node grants in MVP
 * (Option B in the design proposal). `attributes` is an open jsonb
 * bag for mass, power, supplier, TRL, mission-specific fields.
 */
export interface ProductNode {
  id: string
  projectId: string
  parentNodeId: string | null
  kind: ProductNodeKind
  name: string
  partNumber: string | null
  description: string | null
  attributes: Record<string, unknown>
  createdBy: string     // users.id
  createdAt: string     // ISO 8601 with offset
  updatedAt: string
  archivedAt: string | null
  myRole: AiperRole | null   // inherited from the parent project
}

/**
 * Response shape of GET /api/v1/projects/:pid/product-tree. `nodes` is
 * a DFS preorder walk from every root, siblings sorted by
 * lower(name) — same convention E2's ProjectFolderTree uses. Consumers
 * can rebuild the visual tree by walking parentNodeId, or trust the
 * order for a flat "expandable list" render.
 */
export interface ProductTreeResponse {
  project: Project
  nodes: ProductNode[]
}

/**
 * A single doc↔node link row. Same node can link the same document
 * under multiple relations (design-spec AND sign-off) — each shows up
 * here as a separate ProductNodeDocument. Link rows are hard-deleted
 * (associations, not content); the domain audit log carries the
 * link-lifecycle events for regulators.
 */
export interface ProductNodeDocument {
  id: string
  productNodeId: string
  documentId: string
  relation: NodeDocumentRelation
  createdBy: string     // users.id who created the link
  createdAt: string     // ISO 8601 with offset
}

/**
 * Response shape of GET /api/v1/product-nodes/:nid/children and of
 * GET /api/v1/documents/:did/nodes — a small list envelope. Matches
 * the `{ items }` convention E2 established for hierarchy list reads.
 */
export interface ProductNodeList {
  items: ProductNode[]
}

/** Response shape of GET /api/v1/documents/:did/nodes — the reverse
 *  doc↔node lookup used by the traceability drawer. Only links whose
 *  node lives in a project the caller can read are returned; a link
 *  the caller cannot resolve is silently filtered so this endpoint
 *  never reveals a node the caller cannot see. */
export interface NodeDocumentLinkList {
  items: ProductNodeDocument[]
}
