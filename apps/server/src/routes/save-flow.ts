import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type pg from 'pg'
import type { AiperRole } from '@aiper/shared/types'
import {
  ApiErrorSchema,
  DocumentSnapshotSchema,
  SaveRequestSchema,
} from '@aiper/shared/schemas'
import { readSnapshotState, saveSnapshot } from '../snapshots.js'

/**
 * Interim body for POST /save. Extends the frozen SaveRequest with the
 * base64-encoded Yjs update the client currently sends alongside its
 * metadata. Once PR-4 lands, the WS server-side Y.Doc becomes the
 * source of truth and `yjsState` disappears from this body (kept as a
 * fallback for offline reconnect per the kickoff plan).
 *
 * yjsState is capped at 16 MB base64 (≈ 12 MB decoded). Yjs updates
 * for a typical document sit at hundreds of KB even after months of
 * edits, so the cap gives room without letting a client push a Save
 * that would exhaust server memory. The route's bodyLimit override
 * below matches this cap so Fastify's default 1 MB check does not
 * block a legitimate Save.
 */
const YJS_STATE_MAX_BASE64 = 16 * 1024 * 1024
const SaveBodySchema = SaveRequestSchema.extend({
  yjsState: z.string().base64().max(YJS_STATE_MAX_BASE64),
})

const DocumentIdParams = z.object({ did: z.string().uuid() })
const SnapshotStateParams = z.object({
  did: z.string().uuid(),
  sid: z.string().uuid(),
})

/**
 * Highest-role-wins gate for the two save-flow routes. Collapses
 * "document does not exist" and "caller has no grant on this document"
 * into a single 404 — writes are more sensitive than E2's read routes,
 * so we do not want to signal existence to a caller who cannot open
 * the document (kickoff requirement). Callers with SOME grant but not
 * enough for the requested action get a normal 403 — they already know
 * the document exists, so hiding it further would only confuse.
 *
 * Returns the caller's actual role on success; null on rejection (the
 * reply is already sent and the caller should return immediately).
 */
async function requireDocumentRole(
  pool: pg.Pool,
  reply: FastifyReply,
  userId: string,
  documentId: string,
  minRole: AiperRole,
): Promise<AiperRole | null> {
  const rank: Record<AiperRole, number> = { viewer: 1, editor: 2, owner: 3 }

  const r = await pool.query<{ role: AiperRole | null }>(
    `SELECT aiper_effective_access($1, 'document', $2) AS role`,
    [userId, documentId],
  )
  const role = r.rows[0]?.role ?? null

  if (role === null) {
    void reply.code(404).send({ error: 'Not found', code: 'not_found' })
    return null
  }
  if (rank[role] < rank[minRole]) {
    void reply.code(403).send({
      error: `This action requires ${minRole} or above.`,
      code: 'insufficient_role',
    })
    return null
  }
  return role
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
}

export function registerSaveFlowRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // ------------------------------------------------------------- POST /save
  typed.post(
    '/api/v1/documents/:did/save',
    {
      // Fastify's default bodyLimit is 1 MB — Yjs updates for a busy
      // document routinely exceed that once base64-encoded. Raise it to
      // match the schema cap so the check happens where the reader can
      // read it, not as a silent 413 upstream.
      bodyLimit: YJS_STATE_MAX_BASE64 + 4 * 1024,
      schema: {
        summary: "Freeze the current Yjs state as a labelled checkpoint",
        params: DocumentIdParams,
        body: SaveBodySchema,
        response: {
          200: DocumentSnapshotSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did } = req.params
      const body = req.body

      const role = await requireDocumentRole(pool, reply, req.user.id, did, 'editor')
      if (role === null) return

      // Decode after the role check so an unauthorized caller never
      // pays the cost of turning a large base64 body into a Buffer.
      const yjsState = Buffer.from(body.yjsState, 'base64')

      return await saveSnapshot(pool, did, yjsState, {
        reason: 'checkpoint',
        label: body.label ?? null,
        userReason: body.reason ?? null,
        actor: { id: req.user.id, printedName: req.user.displayName },
      })
    },
  )

  // ----------------------------------------------------- GET /state (binary)
  //
  // Bypasses the Zod type provider — the 200 response is raw bytes, not
  // JSON, and the provider narrows return types to declared response
  // schemas which would forbid returning a Buffer. Params still validate
  // against SnapshotStateParams via the validator compiler; runtime
  // safety is identical.
  app.get<{ Params: z.infer<typeof SnapshotStateParams> }>(
    '/api/v1/documents/:did/snapshots/:sid/state',
    {
      schema: {
        summary: "Return the raw Yjs bytes of one snapshot",
        params: SnapshotStateParams,
        response: {
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did, sid } = req.params

      const role = await requireDocumentRole(pool, reply, req.user.id, did, 'viewer')
      if (role === null) return

      const bytes = await readSnapshotState(pool, did, sid)
      if (bytes === null) {
        // Also fires when :sid exists but belongs to another document —
        // the URL-leak guard is inside readSnapshotState's WHERE clause.
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }

      return reply
        .type('application/octet-stream')
        .header('cache-control', 'private, no-store')
        .send(bytes)
    },
  )
}
