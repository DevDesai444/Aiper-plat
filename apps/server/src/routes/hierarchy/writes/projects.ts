import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  ProjectSchema,
  SlugSchema,
} from '@aiper/shared/schemas'
import { writeAudit } from '../../../audit.js'
import { ISO_UTC, printedName, resolveOrDenyForWrite, unauthorized } from './common.js'

const ProjectCreateSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(200),
  slug: SlugSchema,
  description: z.string().max(2000).optional(),
})

// PATCH body: every field optional; at least one must be present or the
// request is a no-op. `archivedAt` accepts an ISO string (archive now with
// a fixed timestamp) or explicit null (unarchive).
const ProjectUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'PATCH body must contain at least one field',
  })

const ProjectIdParams = z.object({ pid: z.string().uuid() })

export function registerProjectWriteRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // --------------------------------------------------------------- POST /projects
  typed.post(
    '/api/v1/projects',
    {
      schema: {
        summary: 'Create a project inside an org the caller is a member of',
        body: ProjectCreateSchema,
        response: {
          201: ProjectSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { orgId, name, slug, description } = req.body
      const userId = req.user.id

      // Org existence + membership check. Existence-leak guard: return 404
      // for a random uuid before evaluating membership.
      const orgExists = await pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [orgId])
      if (orgExists.rowCount === 0) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }
      const isMember = req.user.orgMemberships.some((m) => m.orgId === orgId)
      if (!isMember) {
        return reply.code(403).send({ error: 'No access', code: 'no_access' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // INSERT fires E1's aiper_creator_auto_owns trigger — the caller
        // gets an owner grant on this project atomically with the row.
        const created = await client.query<{
          id: string
          orgId: string
          name: string
          slug: string
          createdBy: string
          createdAt: string
        }>(
          `INSERT INTO projects (org_id, name, slug, description, created_by)
             VALUES ($1, $2, $3, $4, $5)
           RETURNING id,
                     org_id     AS "orgId",
                     name,
                     slug,
                     created_by AS "createdBy",
                     to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt"`,
          [orgId, name, slug, description ?? null, userId],
        )
        const project = created.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'project.created',
          subjectType: 'project',
          subjectId: project.id,
          newValue: { name, slug, description: description ?? null, orgId },
        })

        await client.query('COMMIT')
        return reply.code(201).send({ ...project, myRole: 'owner' })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'Slug already in use in this org', code: 'duplicate_slug' })
        }
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- PATCH /projects/:pid
  typed.patch(
    '/api/v1/projects/:pid',
    {
      schema: {
        summary: 'Rename / describe / archive a project',
        params: ProjectIdParams,
        body: ProjectUpdateSchema,
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
      const body = req.body
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'project', pid, 'editor')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Snapshot the current row for audit oldValue — needs to live inside
        // the same txn so the update-then-read race is impossible.
        const before = await client.query<{
          name: string
          description: string | null
          archivedAt: string | null
        }>(
          `SELECT name, description,
                  to_char(archived_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "archivedAt"
             FROM projects WHERE id = $1 FOR UPDATE`,
          [pid],
        )
        const prev = before.rows[0]!

        const next = {
          name: body.name ?? prev.name,
          description: 'description' in body ? body.description ?? null : prev.description,
          archivedAt: 'archivedAt' in body ? body.archivedAt ?? null : prev.archivedAt,
        }

        const updated = await client.query<{
          id: string
          orgId: string
          name: string
          slug: string
          createdBy: string
          createdAt: string
        }>(
          `UPDATE projects
              SET name        = $1,
                  description = $2,
                  archived_at = $3::timestamptz,
                  updated_at  = now()
            WHERE id = $4
        RETURNING id,
                  org_id     AS "orgId",
                  name,
                  slug,
                  created_by AS "createdBy",
                  to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt"`,
          [next.name, next.description, next.archivedAt, pid],
        )
        const project = updated.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: chooseAction('project', body),
          subjectType: 'project',
          subjectId: pid,
          oldValue: prev,
          newValue: next,
        })

        await client.query('COMMIT')
        return { ...project, myRole: role }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )
}

/** Pick a specific action string when the caller updated exactly one field —
 *  gives the audit log more signal than a flat "project.updated". Falls back
 *  to "<type>.updated" for multi-field PATCHes. */
export function chooseAction(
  subject: 'project' | 'folder' | 'document',
  body: Record<string, unknown>,
): string {
  const keys = Object.keys(body)
  if (keys.length === 1) {
    const k = keys[0]!
    if (k === 'name' || k === 'title') return `${subject}.renamed`
    if (k === 'description') return `${subject}.description_changed`
    if (k === 'archivedAt') return body.archivedAt == null ? `${subject}.unarchived` : `${subject}.archived`
    if (k === 'parentFolderId') return `${subject}.moved`
  }
  return `${subject}.updated`
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
