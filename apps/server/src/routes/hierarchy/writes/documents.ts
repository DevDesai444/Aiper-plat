import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, DocumentSchema } from '@aiper/shared/schemas'
import { writeAudit } from '../../../audit.js'
import { ISO_UTC, printedName, resolveOrDenyForWrite, unauthorized } from './common.js'
import { chooseAction } from './projects.js'

// Only 'authored' documents are created through this route. 'technical-sheet'
// documents come from E4's uploader; 'template' is reserved. The base
// DocumentKind schema accepts all three; enforcement of "only authored via
// POST /documents" happens here rather than in the schema so the DB and
// snapshot layers stay symmetrical.
const DocumentCreateSchema = z.object({
  title: z.string().min(1).max(300),
  kind: z.literal('authored'),
})

// PATCH body. All fields optional; body must contain at least one.
//
// Move semantics: `folderId` and `projectId` express where the document
// should live after the update. Migration 009 enforces EXACTLY ONE of
// folder_id / project_id set — so the client provides exactly one (and
// the other automatically becomes null). Refusing both-set at the API
// boundary gives a 400 with a clearer message than a Postgres 23514.
const DocumentUpdateSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
    folderId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'PATCH body must contain at least one field',
  })
  .refine((body) => !(body.folderId != null && body.projectId != null), {
    message: 'Provide exactly one of folderId or projectId when moving — not both',
  })

const FolderIdParams = z.object({ fid: z.string().uuid() })
const ProjectIdParams = z.object({ pid: z.string().uuid() })
const DocumentIdParams = z.object({ did: z.string().uuid() })

// Columns every document response projects. Shared between the folder-parented
// and project-parented create routes and the PATCH route so the shape can't
// drift between them.
const DOC_RETURNING = `id,
                     folder_id           AS "folderId",
                     project_id          AS "projectId",
                     title,
                     kind,
                     current_snapshot_id AS "currentSnapshotId",
                     created_by          AS "createdBy",
                     to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt"`

interface DocRow {
  id: string
  folderId: string | null
  projectId: string | null
  title: string
  kind: 'authored' | 'technical-sheet' | 'template'
  currentSnapshotId: string | null
  createdBy: string
  createdAt: string
}

/**
 * Look up the project a document currently belongs to.
 *   folder_id set → that folder's project
 *   project_id set → itself
 * Migration 009 guarantees exactly one is set.
 */
async function documentProjectId(
  client: pg.PoolClient | pg.Pool,
  documentId: string,
): Promise<string | null> {
  const r = await client.query<{ project_id: string }>(
    `SELECT COALESCE(f.project_id, d.project_id) AS project_id
       FROM documents d
       LEFT JOIN folders f ON f.id = d.folder_id
      WHERE d.id = $1`,
    [documentId],
  )
  return r.rows[0]?.project_id ?? null
}

export function registerDocumentWriteRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // --------------------------------------------------------------- POST /folders/:fid/documents
  typed.post(
    '/api/v1/folders/:fid/documents',
    {
      schema: {
        summary: "Create an authored document in a folder",
        params: FolderIdParams,
        body: DocumentCreateSchema,
        response: {
          201: DocumentSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { fid } = req.params
      const { title, kind } = req.body
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'folder', fid, 'editor')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const created = await client.query<DocRow>(
          `INSERT INTO documents (folder_id, title, kind, created_by)
             VALUES ($1, $2, $3, $4)
           RETURNING ${DOC_RETURNING}`,
          [fid, title, kind, userId],
        )
        const doc = created.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'document.created',
          subjectType: 'document',
          subjectId: doc.id,
          newValue: { title, kind, folderId: fid },
        })

        await client.query('COMMIT')
        return reply.code(201).send({ ...doc, myRole: 'owner' })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- POST /projects/:pid/documents
  // A document can live directly under a project, not only inside a folder.
  typed.post(
    '/api/v1/projects/:pid/documents',
    {
      schema: {
        summary: 'Create an authored document directly under a project',
        params: ProjectIdParams,
        body: DocumentCreateSchema,
        response: {
          201: DocumentSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { pid } = req.params
      const { title, kind } = req.body
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'project', pid, 'editor')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const created = await client.query<DocRow>(
          `INSERT INTO documents (project_id, title, kind, created_by)
             VALUES ($1, $2, $3, $4)
           RETURNING ${DOC_RETURNING}`,
          [pid, title, kind, userId],
        )
        const doc = created.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'document.created',
          subjectType: 'document',
          subjectId: doc.id,
          newValue: { title, kind, projectId: pid },
        })

        await client.query('COMMIT')
        return reply.code(201).send({ ...doc, myRole: 'owner' })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- PATCH /documents/:did
  //
  // Role threshold splits by operation:
  //   - rename / archive → editor+
  //   - move (folderId or projectId in body) → owner
  // Moves change the location — bigger blast radius, more sensitive than a
  // title edit — so they're an owner-only act. Documented here so the split
  // is obvious to future readers of the route.
  typed.patch(
    '/api/v1/documents/:did',
    {
      schema: {
        summary: 'Rename / move / archive a document',
        params: DocumentIdParams,
        body: DocumentUpdateSchema,
        response: {
          200: DocumentSchema,
          400: ApiErrorSchema,
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
      const userId = req.user.id

      const isMove = 'folderId' in body || 'projectId' in body
      const minRole = isMove ? 'owner' : 'editor'
      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, minRole)
      if (role === null) return

      // Moves also need the caller to have editor+ on the destination and the
      // destination must live in the same project as the document does now —
      // cross-project moves are not supported. Same guard shape as PATCH
      // /folders/:fid for moving folders.
      if (isMove) {
        const currentProj = await documentProjectId(pool, did)
        if (currentProj === null) {
          return reply.code(404).send({ error: 'Not found', code: 'not_found' })
        }

        if (body.folderId) {
          const dst = body.folderId
          const dstRole = await resolveOrDenyForWrite(pool, reply, userId, 'folder', dst, 'editor')
          if (dstRole === null) return
          const dstProj = await pool.query<{ project_id: string }>(
            `SELECT project_id FROM folders WHERE id = $1`,
            [dst],
          )
          if (dstProj.rowCount === 0 || dstProj.rows[0]!.project_id !== currentProj) {
            return reply.code(400).send({
              error: 'Cannot move document across projects',
              code: 'cross_project_move',
            })
          }
        } else if (body.projectId) {
          // Moving directly under a project — the caller needs owner on it
          // via aiper_effective_access (moves are owner-only). Same-project
          // guard: the target project must be the document's current project.
          const dst = body.projectId
          if (dst !== currentProj) {
            return reply.code(400).send({
              error: 'Cannot move document across projects',
              code: 'cross_project_move',
            })
          }
        }
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{
          title: string
          folderId: string | null
          projectId: string | null
          archivedAt: string | null
        }>(
          `SELECT title,
                  folder_id  AS "folderId",
                  project_id AS "projectId",
                  to_char(archived_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "archivedAt"
             FROM documents WHERE id = $1 FOR UPDATE`,
          [did],
        )
        const prev = before.rows[0]!

        // Compute next parent — moving flips folder_id ↔ project_id. If the
        // client didn't touch parents, keep current.
        let nextFolderId: string | null = prev.folderId
        let nextProjectId: string | null = prev.projectId
        if ('folderId' in body) {
          nextFolderId = body.folderId ?? null
          nextProjectId = null
        } else if ('projectId' in body) {
          nextFolderId = null
          nextProjectId = body.projectId ?? null
        }

        const next = {
          title: body.title ?? prev.title,
          folderId: nextFolderId,
          projectId: nextProjectId,
          archivedAt: 'archivedAt' in body ? body.archivedAt ?? null : prev.archivedAt,
        }

        const updated = await client.query<DocRow>(
          `UPDATE documents
              SET title       = $1,
                  folder_id   = $2,
                  project_id  = $3,
                  archived_at = $4::timestamptz,
                  updated_at  = now()
            WHERE id = $5
        RETURNING ${DOC_RETURNING}`,
          [next.title, next.folderId, next.projectId, next.archivedAt, did],
        )
        const doc = updated.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: chooseAction('document', body),
          subjectType: 'document',
          subjectId: did,
          oldValue: prev,
          newValue: next,
        })

        await client.query('COMMIT')
        return { ...doc, myRole: role }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- DELETE /documents/:did
  //
  // Owner-only — delete is destructive and irreversible from the API. FK
  // cascades in migrations 007 (comments) and 008 (document_snapshots)
  // take care of dependent rows; the audit row lands before the CASCADE
  // fires so nothing about the deleted document is silently lost.
  typed.delete(
    '/api/v1/documents/:did',
    {
      schema: {
        summary: 'Delete a document (cascades to snapshots and comments)',
        params: DocumentIdParams,
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
      const { did } = req.params
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'owner')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{
          title: string
          folderId: string | null
          projectId: string | null
          kind: string
        }>(
          `SELECT title,
                  folder_id  AS "folderId",
                  project_id AS "projectId",
                  kind
             FROM documents WHERE id = $1 FOR UPDATE`,
          [did],
        )
        const prev = before.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'document.deleted',
          subjectType: 'document',
          subjectId: did,
          oldValue: prev,
        })

        await client.query(`DELETE FROM documents WHERE id = $1`, [did])
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
