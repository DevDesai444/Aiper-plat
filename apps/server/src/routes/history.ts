import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type pg from 'pg'
import type { AiperRole, DocumentSnapshot } from '@aiper/shared/types'
import { ApiErrorSchema, SnapshotListSchema } from '@aiper/shared/schemas'

/**
 * Save-timeline read — one row per saved snapshot on the document, newest
 * first. The response is metadata only; the Yjs bytes live on a separate
 * binary endpoint (GET /api/v1/documents/:did/snapshots/:sid/state) so
 * the timeline stays cheap to fetch and JSON-friendly.
 *
 * Access: viewer+ on the document. Non-existent doc and no-grant-at-all
 * collapse to a single 404 so a caller cannot enumerate documents by
 * distinguishing "does not exist" from "cannot open". Same guard the
 * save flow uses; consistent across every E3 route.
 *
 * Ordering: saved_at DESC — matches document_snapshots_doc_saved_idx so
 * the read is one index range scan, not a sort.
 */

const DocumentIdParams = z.object({ did: z.string().uuid() })

export function registerHistoryRoute(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/api/v1/documents/:did/history',
    {
      schema: {
        summary: 'List Save-timeline snapshots for a document (newest first)',
        params: DocumentIdParams,
        response: {
          200: SnapshotListSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
      }
      const { did } = req.params

      // viewer is the minimum on this route — any role suffices. The
      // 404 branch fires for both non-existent doc and no-grant, so
      // there is no separate 403 case to handle here.
      const r = await pool.query<{ role: AiperRole | null }>(
        `SELECT aiper_effective_access($1, 'document', $2) AS role`,
        [req.user.id, did],
      )
      if (!r.rows[0]?.role) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }

      const rows = await pool.query<DocumentSnapshot>(
        `SELECT id,
                document_id AS "documentId",
                saved_by    AS "savedBy",
                to_char(saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "savedAt",
                reason,
                label
           FROM document_snapshots
          WHERE document_id = $1
          ORDER BY saved_at DESC`,
        [did],
      )
      return { snapshots: rows.rows }
    },
  )
}
