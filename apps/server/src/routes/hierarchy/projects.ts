import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  ProjectSchema,
  ProjectFolderTreeSchema,
} from '@aiper/shared/schemas'
import type { AiperRole, DocumentKind } from '@aiper/shared/types'
import { resolveOrDeny, unauthorized } from './common.js'

const ProjectIdParams = z.object({ pid: z.string().uuid() })

export function registerProjectReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // One project's metadata + caller's role.
  typed.get(
    '/api/v1/projects/:pid',
    {
      schema: {
        summary: "Return one project's metadata and the caller's effective role",
        params: ProjectIdParams,
        response: {
          200: ProjectSchema,
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
                org_id     AS "orgId",
                name,
                slug,
                created_by AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM projects
          WHERE id = $1`,
        [pid],
      )
      return { ...rows.rows[0], myRole: role }
    },
  )

  // Full folder tree for a project. Access-gate on the project; if that
  // succeeds, every folder in the project is reachable via the highest-
  // wins walk (a grant on the project necessarily covers every descendant
  // that doesn't have its own higher grant). Any folder whose resolver
  // does still return null is omitted defensively — future access-model
  // changes might introduce that state.
  typed.get(
    '/api/v1/projects/:pid/folders',
    {
      schema: {
        summary: 'Return the caller-reachable folder tree for a project',
        params: ProjectIdParams,
        response: {
          200: ProjectFolderTreeSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { pid } = req.params

      const projectRole = await resolveOrDeny(pool, reply, req.user.id, 'project', pid)
      if (projectRole === null) return

      // Project shape for the outer wrapper.
      const projRow = await pool.query(
        `SELECT id, org_id AS "orgId", name, slug,
                created_by AS "createdBy",
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM projects WHERE id = $1`,
        [pid],
      )
      const project = { ...projRow.rows[0], myRole: projectRole }

      // Flat SELECT of every folder in the project. aiper_effective_access
      // is STABLE, so PostgreSQL can inline / cache it per row of the
      // query — one round-trip regardless of tree size.
      const folderRows = await pool.query<{
        id: string
        projectId: string
        parentFolderId: string | null
        name: string
        createdBy: string
        createdAt: string
        myRole: AiperRole | null
      }>(
        `SELECT f.id,
                f.project_id       AS "projectId",
                f.parent_folder_id AS "parentFolderId",
                f.name,
                f.created_by       AS "createdBy",
                to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
                aiper_effective_access($1, 'folder', f.id) AS "myRole"
           FROM folders f
          WHERE f.project_id = $2`,
        [req.user.id, pid],
      )
      const reachableFolders = folderRows.rows.filter((f) => f.myRole !== null)

      // Documents in those folders. Filtered by reachable folders — a
      // document under an unreachable subtree stays hidden.
      const folderIds = reachableFolders.map((f) => f.id)
      const docRows = folderIds.length === 0
        ? { rows: [] as Array<{ id: string; folderId: string; title: string; kind: DocumentKind }> }
        : await pool.query<{ id: string; folderId: string; title: string; kind: DocumentKind }>(
            `SELECT id, folder_id AS "folderId", title, kind
               FROM documents
              WHERE folder_id = ANY($1::uuid[])`,
            [folderIds],
          )

      // Build the tree. Sort each folder's children (and root list) by
      // name.toLowerCase() so the Navigator's DFS preorder is deterministic
      // regardless of insert order — see ProjectFolderTree's docstring.
      const childrenByParent = new Map<string | null, typeof reachableFolders>()
      for (const f of reachableFolders) {
        const bucket = childrenByParent.get(f.parentFolderId) ?? []
        bucket.push(f)
        childrenByParent.set(f.parentFolderId, bucket)
      }
      for (const bucket of childrenByParent.values()) {
        bucket.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      }

      const docsByFolder = new Map<string, typeof docRows.rows>()
      for (const d of docRows.rows) {
        const bucket = docsByFolder.get(d.folderId) ?? []
        bucket.push(d)
        docsByFolder.set(d.folderId, bucket)
      }
      for (const bucket of docsByFolder.values()) {
        bucket.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()))
      }

      const flat: Array<{
        folder: (typeof reachableFolders)[number]
        children: Array<{ id: string; name: string }>
        documents: Array<{ id: string; title: string; kind: DocumentKind }>
      }> = []
      const dfs = (parentId: string | null): void => {
        for (const folder of childrenByParent.get(parentId) ?? []) {
          const children = (childrenByParent.get(folder.id) ?? []).map((c) => ({
            id: c.id,
            name: c.name,
          }))
          const documents = (docsByFolder.get(folder.id) ?? []).map((d) => ({
            id: d.id,
            title: d.title,
            kind: d.kind,
          }))
          flat.push({ folder, children, documents })
          dfs(folder.id)
        }
      }
      dfs(null)

      return { project, folders: flat }
    },
  )
}
