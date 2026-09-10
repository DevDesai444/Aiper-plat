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

const DocumentUpdateSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'PATCH body must contain at least one field',
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
  typed.patch(
    '/api/v1/documents/:did',
    {
      schema: {
        summary: 'Rename / archive a document',
        params: DocumentIdParams,
        body: DocumentUpdateSchema,
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
      const body = req.body
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'editor')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{
          title: string
          archivedAt: string | null
        }>(
          `SELECT title,
                  to_char(archived_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "archivedAt"
             FROM documents WHERE id = $1 FOR UPDATE`,
          [did],
        )
        const prev = before.rows[0]!

        const next = {
          title: body.title ?? prev.title,
          archivedAt: 'archivedAt' in body ? body.archivedAt ?? null : prev.archivedAt,
        }

        const updated = await client.query<DocRow>(
          `UPDATE documents
              SET title       = $1,
                  archived_at = $2::timestamptz,
                  updated_at  = now()
            WHERE id = $3
        RETURNING ${DOC_RETURNING}`,
          [next.title, next.archivedAt, did],
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
}
