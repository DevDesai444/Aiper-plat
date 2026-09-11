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
  //
  // Role threshold splits by operation:
  //   - rename / archive → editor+
  //   - move (parentFolderId in body) → owner
  // Moves change the location and blast radius (a subtree can rotate into
  // a different corner of the tree); the destructive-adjacent nature makes
  // them an owner-only act, matching the peer convention for delete/move.
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

      const isMove = 'parentFolderId' in body
      const minRole = isMove ? 'owner' : 'editor'
      const role = await resolveOrDenyForWrite(pool, reply, userId, 'folder', fid, minRole)
      if (role === null) return

      // If the request moves this folder under a new parent, the caller
      // also needs editor+ on the destination and the destination must
      // stay in the same project. `parentFolderId: null` is legal (move
      // to project root) and skips both checks.
      if (isMove && body.parentFolderId != null) {
        const newParent = body.parentFolderId

        // Self-parent is caught by the folders_no_self_parent CHECK from
        // migration 006, but the API returns a nicer error than a raw
        // 23514 by short-circuiting here.
        if (newParent === fid) {
          return reply.code(400).send({
            error: 'A folder cannot be its own parent',
            code: 'self_parent',
          })
        }

        const parentRole = await resolveOrDenyForWrite(
          pool,
          reply,
          userId,
          'folder',
          newParent,
          'editor',
        )
        if (parentRole === null) return

        // Same-project guard.
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

        // Cycle guard. Walk parents up from the proposed destination; if
        // we hit fid, moving would make fid its own descendant. The
        // recursive CTE resolves in one round-trip and is bounded by
        // tree depth. `parent_folder_id IS NOT NULL` in the recursive
        // step is what stops the walk at the project root.
        const cycle = await pool.query<{ is_cycle: boolean }>(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_folder_id FROM folders WHERE id = $1
             UNION ALL
             SELECT f.id, f.parent_folder_id
               FROM folders f
               JOIN ancestors a ON a.parent_folder_id = f.id
              WHERE a.parent_folder_id IS NOT NULL
           )
           SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2) AS is_cycle`,
          [newParent, fid],
        )
        if (cycle.rows[0]?.is_cycle) {
          return reply.code(400).send({
            error: 'A folder cannot become a descendant of itself',
            code: 'folder_cycle',
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

  // --------------------------------------------------------------- DELETE /folders/:fid
  //
  // Owner-only. FK cascades on folders.parent_folder_id and every child
  // table (documents.folder_id, comments.document_id, snapshots.document_id)
  // remove the subtree — a delete on a folder near the root of a project
  // can remove a lot of rows. The audit row lands before the DELETE so
  // the deleted subtree is at least named for the record.
  typed.delete(
    '/api/v1/folders/:fid',
    {
      schema: {
        summary: 'Delete a folder (cascades to child folders, documents, snapshots, comments)',
        params: FolderIdParams,
        response: {
          204: z.null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { fid } = req.params
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'folder', fid, 'owner')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{
          name: string
          projectId: string
          parentFolderId: string | null
        }>(
          `SELECT name,
                  project_id       AS "projectId",
                  parent_folder_id AS "parentFolderId"
             FROM folders WHERE id = $1 FOR UPDATE`,
          [fid],
        )
        const prev = before.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'folder.deleted',
          subjectType: 'folder',
          subjectId: fid,
          oldValue: prev,
        })

        // Migration 003 (E1's hierarchy stubs) didn't declare ON DELETE
        // CASCADE on folders.parent_folder_id or documents.folder_id, so
        // a naive DELETE at the root of a subtree errors with an FK
        // violation. Hand-cascade in the same txn: gather every
        // descendant folder id via a recursive CTE, delete all
        // documents anchored to any of them (comments cascade off
        // documents via migration 007), then delete the folders bulk in
        // one statement (Postgres checks FKs at statement end, so a
        // single DELETE for the whole set does not trip the
        // parent-folder FK on itself).
        const subtree = await client.query<{ id: string }>(
          `WITH RECURSIVE tree AS (
             SELECT id FROM folders WHERE id = $1
             UNION ALL
             SELECT f.id FROM folders f JOIN tree t ON f.parent_folder_id = t.id
           )
           SELECT id FROM tree`,
          [fid],
        )
        const folderIds = subtree.rows.map((r) => r.id)
        await client.query(`DELETE FROM documents WHERE folder_id = ANY($1::uuid[])`, [folderIds])
        await client.query(`DELETE FROM folders   WHERE id        = ANY($1::uuid[])`, [folderIds])
        await client.query('COMMIT')
        return reply.code(204).send(null)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )
}
