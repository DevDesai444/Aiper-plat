import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  DocumentSchema,
  FolderSchema,
} from '@aiper/shared/schemas'
import type { AiperRole } from '@aiper/shared/types'
import { resolveOrDeny, unauthorized } from './common.js'

const FolderIdParams = z.object({ fid: z.string().uuid() })
const DocumentListResponse = z.object({ items: z.array(DocumentSchema) })

export function registerFolderReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // One folder's metadata + caller's role.
  typed.get(
    '/api/v1/folders/:fid',
    {
      schema: {
        summary: "Return one folder's metadata and the caller's effective role",
        params: FolderIdParams,
        response: {
          200: FolderSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { fid } = req.params

      const role = await resolveOrDeny(pool, reply, req.user.id, 'folder', fid)
      if (role === null) return

      const rows = await pool.query(
        `SELECT id,
                project_id       AS "projectId",
                parent_folder_id AS "parentFolderId",
                name,
                created_by       AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM folders WHERE id = $1`,
        [fid],
      )
      return { ...rows.rows[0], myRole: role }
    },
  )

  // Documents directly inside a folder — no recursion into subfolders,
  // that's the tree endpoint's job. Each document carries its own myRole
  // via the resolver so the UI can enable / disable edit buttons per row
  // without extra round-trips.
  typed.get(
    '/api/v1/folders/:fid/documents',
    {
      schema: {
        summary: 'List documents directly inside a folder (non-recursive)',
        params: FolderIdParams,
        response: {
          200: DocumentListResponse,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { fid } = req.params

      const folderRole = await resolveOrDeny(pool, reply, req.user.id, 'folder', fid)
      if (folderRole === null) return

      const rows = await pool.query<{
        id: string
        folderId: string
        title: string
        kind: 'authored' | 'technical-sheet' | 'template'
        currentSnapshotId: string | null
        createdBy: string
        createdAt: string
        myRole: AiperRole | null
      }>(
        `SELECT id,
                folder_id           AS "folderId",
                title,
                kind,
                current_snapshot_id AS "currentSnapshotId",
                created_by          AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
                aiper_effective_access($1, 'document', id) AS "myRole"
           FROM documents
          WHERE folder_id = $2
          ORDER BY lower(title)`,
        [req.user.id, fid],
      )
      const items = rows.rows.filter((r) => r.myRole !== null)
      return { items }
    },
  )
}
