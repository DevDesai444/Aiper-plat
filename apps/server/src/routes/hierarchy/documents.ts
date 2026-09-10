import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  CommentSchema,
  DocumentSchema,
} from '@aiper/shared/schemas'
import { resolveOrDeny, unauthorized } from './common.js'

const DocumentIdParams = z.object({ did: z.string().uuid() })
const CommentListResponse = z.object({ items: z.array(CommentSchema) })

export function registerDocumentReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // One document's metadata + caller's role.
  typed.get(
    '/api/v1/documents/:did',
    {
      schema: {
        summary: "Return one document's metadata and the caller's effective role",
        params: DocumentIdParams,
        response: {
          200: DocumentSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did } = req.params

      const role = await resolveOrDeny(pool, reply, req.user.id, 'document', did)
      if (role === null) return

      const rows = await pool.query(
        `SELECT id,
                folder_id           AS "folderId",
                project_id          AS "projectId",
                title,
                kind,
                current_snapshot_id AS "currentSnapshotId",
                created_by          AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM documents WHERE id = $1`,
        [did],
      )
      return { ...rows.rows[0], myRole: role }
    },
  )

  // Documents that live directly under a project (folder_id IS NULL).
  // Access-gated on the project.
  typed.get(
    '/api/v1/projects/:pid/documents',
    {
      schema: {
        summary: 'List documents directly under a project (not inside any folder)',
        params: z.object({ pid: z.string().uuid() }),
        response: {
          200: z.object({ items: z.array(DocumentSchema) }),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { pid } = req.params

      const role = await resolveOrDeny(pool, reply, req.user.id, 'project', pid)
      if (role === null) return

      const rows = await pool.query(
        `SELECT id,
                folder_id           AS "folderId",
                project_id          AS "projectId",
                title,
                kind,
                current_snapshot_id AS "currentSnapshotId",
                created_by          AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
                aiper_effective_access($1, 'document', id) AS "myRole"
           FROM documents
          WHERE project_id = $2 AND folder_id IS NULL
          ORDER BY lower(title)`,
        [req.user.id, pid],
      )
      return { items: rows.rows }
    },
  )

  // Comments on a document. Ordered by created_at so the Navigator's feed
  // renders in the same order every viewer sees. Access gate is on the
  // document itself — a viewer of the doc can read every comment on it;
  // per-comment permissions are out of scope.
  typed.get(
    '/api/v1/documents/:did/comments',
    {
      schema: {
        summary: 'List comments on a document, oldest first',
        params: DocumentIdParams,
        response: {
          200: CommentListResponse,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did } = req.params

      const role = await resolveOrDeny(pool, reply, req.user.id, 'document', did)
      if (role === null) return

      const rows = await pool.query(
        `SELECT id,
                document_id         AS "documentId",
                mark_id             AS "markId",
                COALESCE(quoted_text, '')  AS "quotedText",
                body,
                author_id           AS "authorId",
                author_display_name AS "authorDisplayName",
                to_char(created_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
                to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "resolvedAt",
                resolved_by         AS "resolvedBy"
           FROM comments
          WHERE document_id = $1
          ORDER BY created_at ASC, id ASC`,
        [did],
      )
      return { items: rows.rows }
    },
  )
}
