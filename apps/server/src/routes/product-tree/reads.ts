import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type pg from 'pg'
import type { AiperRole, ProductNode } from '@aiper/shared/types'
import {
  ApiErrorSchema,
  NodeDocumentLinkListSchema,
  ProductNodeListSchema,
  ProductNodeSchema,
  ProductTreeResponseSchema,
} from '@aiper/shared/schemas'
import { requireDocumentViewer, requireProjectViewer, unauthorized } from './common.js'

/**
 * Product-tree read routes. All viewer+ on the relevant project via
 * aiper_effective_access; 404-existence-hiding on every entry point.
 * myRole on the response is the caller's role on the parent project
 * — nodes carry no per-node grants (Option B from the signed-off
 * design proposal).
 *
 * Route inventory:
 *   GET /api/v1/projects/:pid/product-tree
 *     → ProductTreeResponse { project, nodes: ProductNode[] }
 *     DFS preorder from every root, siblings sorted by lower(name).
 *     Non-archived only.
 *
 *   GET /api/v1/product-nodes/:nid
 *     → ProductNode. Access resolves through the node's parent
 *     project. Archived nodes are still readable so E6 can render a
 *     grey-out state.
 *
 *   GET /api/v1/product-nodes/:nid/children
 *     → ProductNodeList { items }. Non-archived direct children only,
 *     sorted by lower(name). Lazy-tree UI feed.
 *
 *   GET /api/v1/documents/:did/nodes
 *     → NodeDocumentLinkList { items }. Reverse doc↔node lookup for
 *     the traceability drawer. Links whose node the caller cannot
 *     read (no grant on the node's project) are silently filtered so
 *     the endpoint never reveals a part outside the caller's reach.
 */

const ProjectIdParams  = z.object({ pid: z.string().uuid() })
const NodeIdParams     = z.object({ nid: z.string().uuid() })
const DocumentIdParams = z.object({ did: z.string().uuid() })

/** Shared SELECT list for one product_node row. Kept in one place so
 *  every route serialises the same fields under the same keys — a
 *  drifted alias would break ProductNodeSchema validation. */
const NODE_COLS = `
  n.id,
  n.project_id                       AS "projectId",
  n.parent_node_id                   AS "parentNodeId",
  n.kind,
  n.name,
  n.part_number                      AS "partNumber",
  n.description,
  n.attributes,
  n.created_by                       AS "createdBy",
  to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  CASE WHEN n.archived_at IS NULL THEN NULL
       ELSE to_char(n.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END                                AS "archivedAt"
`

/**
 * DFS preorder walk from every root of a node list. Sibling order
 * comes from the SQL (ORDER BY lower(name)); we keep that order
 * stable while descending into children. This runs in JS rather than
 * a recursive CTE because we already have the whole set in memory
 * for the tree endpoint, and the JS walk is cheaper to reason about.
 */
function dfsPreorder(all: ProductNode[]): ProductNode[] {
  const byParent = new Map<string | null, ProductNode[]>()
  for (const n of all) {
    const key = n.parentNodeId
    const bucket = byParent.get(key)
    if (bucket) bucket.push(n)
    else byParent.set(key, [n])
  }
  const out: ProductNode[] = []
  const walk = (parent: string | null): void => {
    const children = byParent.get(parent) ?? []
    for (const child of children) {
      out.push(child)
      walk(child.id)
    }
  }
  walk(null)
  return out
}

export function registerProductTreeReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // ---------------------------------------------- GET /projects/:pid/product-tree
  typed.get(
    '/api/v1/projects/:pid/product-tree',
    {
      schema: {
        summary: "Return one project's full product tree",
        params: ProjectIdParams,
        response: {
          200: ProductTreeResponseSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { pid } = req.params

      const role = await requireProjectViewer(pool, reply, req.user.id, pid)
      if (role === null) return

      // Project envelope for the response. Serialised in the same
      // shape ProjectSchema expects (matches E2's read).
      const projectRow = await pool.query<{
        id: string
        orgId: string
        name: string
        slug: string
        createdBy: string
        createdAt: string
      }>(
        `SELECT id,
                org_id     AS "orgId",
                name,
                slug,
                created_by AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM projects WHERE id = $1`,
        [pid],
      )
      const project = projectRow.rows[0]
      if (!project) {
        // Should never miss — the resolver just confirmed the row is
        // reachable — but guard anyway. Same 404 shape everything else
        // returns.
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }

      const rows = await pool.query<ProductNode>(
        `SELECT ${NODE_COLS}
           FROM product_nodes n
          WHERE n.project_id = $1
            AND n.archived_at IS NULL
          ORDER BY lower(n.name)`,
        [pid],
      )
      // myRole on every node = the caller's role on the project.
      // Nodes have no per-node grants in MVP.
      const nodes = dfsPreorder(rows.rows).map((n) => ({ ...n, myRole: role }))

      return {
        project: { ...project, myRole: role },
        nodes,
      }
    },
  )

  // ------------------------------------------------------ GET /product-nodes/:nid
  typed.get(
    '/api/v1/product-nodes/:nid',
    {
      schema: {
        summary: "Return one product node with its parent-project role",
        params: NodeIdParams,
        response: {
          200: ProductNodeSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { nid } = req.params

      // Find the node's project first — the resolver is keyed on
      // project, not node.
      const nodeRow = await pool.query<{ project_id: string }>(
        `SELECT project_id FROM product_nodes WHERE id = $1`,
        [nid],
      )
      if (nodeRow.rowCount === 0) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }

      const role = await requireProjectViewer(
        pool,
        reply,
        req.user.id,
        nodeRow.rows[0]!.project_id,
      )
      if (role === null) return

      const row = await pool.query<ProductNode>(
        `SELECT ${NODE_COLS} FROM product_nodes n WHERE n.id = $1`,
        [nid],
      )
      if (row.rowCount === 0) {
        // Only reachable if the node was hard-deleted between the two
        // queries above; still a valid 404.
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }
      return { ...row.rows[0]!, myRole: role }
    },
  )

  // -------------------------------------------- GET /product-nodes/:nid/children
  typed.get(
    '/api/v1/product-nodes/:nid/children',
    {
      schema: {
        summary: "Direct children of one product node (non-recursive)",
        params: NodeIdParams,
        response: {
          200: ProductNodeListSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { nid } = req.params

      const parentRow = await pool.query<{ project_id: string }>(
        `SELECT project_id FROM product_nodes WHERE id = $1`,
        [nid],
      )
      if (parentRow.rowCount === 0) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }
      const role = await requireProjectViewer(
        pool,
        reply,
        req.user.id,
        parentRow.rows[0]!.project_id,
      )
      if (role === null) return

      const rows = await pool.query<ProductNode>(
        `SELECT ${NODE_COLS}
           FROM product_nodes n
          WHERE n.parent_node_id = $1
            AND n.archived_at IS NULL
          ORDER BY lower(n.name)`,
        [nid],
      )
      return { items: rows.rows.map((n) => ({ ...n, myRole: role })) }
    },
  )

  // ------------------------------------------- GET /documents/:did/nodes (reverse)
  typed.get(
    '/api/v1/documents/:did/nodes',
    {
      schema: {
        summary: "Which product nodes reference this document?",
        params: DocumentIdParams,
        response: {
          200: NodeDocumentLinkListSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did } = req.params

      const docRole = await requireDocumentViewer(pool, reply, req.user.id, did)
      if (docRole === null) return

      // Filter link rows to those whose node's parent project the
      // caller can also reach. A doc-viewer with no access to the
      // node's project sees no link — the endpoint never reveals a
      // part outside their reach. The resolver is STABLE, so PG
      // caches within one query.
      const rows = await pool.query<{
        id: string
        productNodeId: string
        documentId: string
        relation: 'reference' | 'design-spec' | 'test-report' | 'sign-off' | 'requirement'
        createdBy: string
        createdAt: string
      }>(
        `SELECT pnd.id,
                pnd.product_node_id AS "productNodeId",
                pnd.document_id     AS "documentId",
                pnd.relation,
                pnd.created_by      AS "createdBy",
                to_char(pnd.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM product_node_documents pnd
           JOIN product_nodes pn ON pnd.product_node_id = pn.id
          WHERE pnd.document_id = $1
            AND aiper_effective_access($2, 'project', pn.project_id) IS NOT NULL
          ORDER BY pnd.created_at ASC`,
        [did, req.user.id],
      )
      return { items: rows.rows }
    },
  )
}
