import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, FolderSchema } from '@aiper/shared/schemas'
import { writeAudit } from '../../../audit.js'
import { ISO_UTC, printedName, resolveOrDenyForWrite, unauthorized } from './common.js'
import { chooseAction } from './projects.js'

const FolderCreateSchema = z.object({
  parentFolderId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
})

const FolderUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    parentFolderId: z.string().uuid().nullable().optional(),
    archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'PATCH body must contain at least one field',
  })

const ProjectIdParams = z.object({ pid: z.string().uuid() })
const FolderIdParams = z.object({ fid: z.string().uuid() })

export function registerFolderWriteRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // --------------------------------------------------------------- POST /projects/:pid/folders
  //
  // Caller needs editor+ on the project (or on the specific parent folder,
  // if the request nests inside one). A viewer of the project cannot create
  // folders; an editor of a subfolder can create children of that subfolder
  // via the highest-wins walk from parent → project.
  typed.post(
    '/api/v1/projects/:pid/folders',
    {
      schema: {
        summary: 'Create a folder inside a project',
        params: ProjectIdParams,
        body: FolderCreateSchema,
        response: {
          201: FolderSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { pid } = req.params
      const { parentFolderId, name } = req.body
      const userId = req.user.id

      // The role that actually matters is on the write location:
      //   - creating at the project root  → check project
      //   - creating inside a subfolder   → check that subfolder
      // Highest-wins means a project grant covers the subfolder anyway, but
      // this is what makes viewer-on-a-subfolder-they-share fail cleanly.
      let role
      if (parentFolderId) {
        role = await resolveOrDenyForWrite(pool, reply, userId, 'folder', parentFolderId, 'editor')
      } else {
        role = await resolveOrDenyForWrite(pool, reply, userId, 'project', pid, 'editor')
      }
      if (role === null) return

      // If a parentFolderId was given, verify it actually belongs to this
      // project — otherwise a caller with editor on folder A in project X
      // could create children of A that claim to live under project Y.
      if (parentFolderId) {
        const parentCheck = await pool.query<{ project_id: string }>(
          `SELECT project_id FROM folders WHERE id = $1`,
          [parentFolderId],
        )
        if (parentCheck.rowCount === 0 || parentCheck.rows[0]!.project_id !== pid) {
          return reply.code(404).send({ error: 'Parent folder not in project', code: 'not_found' })
        }
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const created = await client.query<{
          id: string
          projectId: string
          parentFolderId: string | null
          name: string
          createdBy: string
          createdAt: string
        }>(
          `INSERT INTO folders (project_id, parent_folder_id, name, created_by)
             VALUES ($1, $2, $3, $4)
           RETURNING id,
                     project_id       AS "projectId",
                     parent_folder_id AS "parentFolderId",
                     name,
                     created_by       AS "createdBy",
                     to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt"`,
          [pid, parentFolderId ?? null, name, userId],
        )
        const folder = created.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'folder.created',
          subjectType: 'folder',
          subjectId: folder.id,
          newValue: { name, projectId: pid, parentFolderId: parentFolderId ?? null },
        })

        await client.query('COMMIT')
        // Creator gets 'owner' via aiper_creator_auto_owns. Their effective
        // role could theoretically be even higher if that ever happens, but
        // 'owner' is the top of the ladder — the trigger's grant is what
        // will win the resolver walk regardless.
        return reply.code(201).send({ ...folder, myRole: 'owner' })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- PATCH /folders/:fid
  typed.patch(
    '/api/v1/folders/:fid',
    {
      schema: {
        summary: 'Rename / move / archive a folder',
        params: FolderIdParams,
        body: FolderUpdateSchema,
        response: {
          200: FolderSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { fid } = req.params
      const body = req.body
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'folder', fid, 'editor')
      if (role === null) return

      // If the request moves this folder under a new parent, the caller
      // also needs editor+ on the destination — otherwise they could drag
      // a folder they can edit into a subtree they merely view, ending up
      // writing to a place they otherwise couldn't.
      if ('parentFolderId' in body && body.parentFolderId != null) {
        const newParent = body.parentFolderId
        const parentRole = await resolveOrDenyForWrite(
          pool,
          reply,
          userId,
          'folder',
          newParent,
          'editor',
        )
        if (parentRole === null) return
        // Same-project guard as on create — a folder can only be moved
        // within its own project.
        const projCheck = await pool.query<{ project_id: string }>(
          `SELECT project_id FROM folders WHERE id = $1`,
          [newParent],
        )
        const currentProj = await pool.query<{ project_id: string }>(
          `SELECT project_id FROM folders WHERE id = $1`,
          [fid],
        )
        if (
          projCheck.rowCount === 0 ||
          currentProj.rowCount === 0 ||
          projCheck.rows[0]!.project_id !== currentProj.rows[0]!.project_id
        ) {
          return reply.code(400).send({
            error: 'Cannot move folder across projects',
            code: 'cross_project_move',
          })
        }
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{
          name: string
          parentFolderId: string | null
          archivedAt: string | null
        }>(
          `SELECT name,
                  parent_folder_id AS "parentFolderId",
                  to_char(archived_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "archivedAt"
             FROM folders WHERE id = $1 FOR UPDATE`,
          [fid],
        )
        const prev = before.rows[0]!

        const next = {
          name: body.name ?? prev.name,
          parentFolderId:
            'parentFolderId' in body ? body.parentFolderId ?? null : prev.parentFolderId,
          archivedAt: 'archivedAt' in body ? body.archivedAt ?? null : prev.archivedAt,
        }

        const updated = await client.query<{
          id: string
          projectId: string
          parentFolderId: string | null
          name: string
          createdBy: string
          createdAt: string
        }>(
          `UPDATE folders
              SET name             = $1,
                  parent_folder_id = $2,
                  archived_at      = $3::timestamptz,
                  updated_at       = now()
            WHERE id = $4
        RETURNING id,
                  project_id       AS "projectId",
                  parent_folder_id AS "parentFolderId",
                  name,
                  created_by       AS "createdBy",
                  to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt"`,
          [next.name, next.parentFolderId, next.archivedAt, fid],
        )
        const folder = updated.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: chooseAction('folder', body),
          subjectType: 'folder',
          subjectId: fid,
          oldValue: prev,
          newValue: next,
        })

        await client.query('COMMIT')
        return { ...folder, myRole: role }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )
}
