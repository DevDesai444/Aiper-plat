import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  OrganizationSchema,
  SlugSchema,
} from '@aiper/shared/schemas'
import { ISO_UTC, unauthorized } from './common.js'

const OrgCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: SlugSchema,
})

export function registerOrgWriteRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // Create an org. Any authenticated caller may create one — the caller
  // becomes an 'admin' member of the new org via org_members. The
  // uniqueness constraint on organizations.slug (from E1's 002 migration)
  // means a duplicate slug returns a 23505 that we convert to a 409.
  //
  // Transactional: the organizations INSERT and the org_members INSERT
  // must be atomic — an org that exists without an admin can never be
  // administered.
  typed.post(
    '/api/v1/orgs',
    {
      schema: {
        summary: 'Create an organization; caller becomes its first admin',
        body: OrgCreateSchema,
        response: {
          201: OrganizationSchema,
          401: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { name, slug } = req.body
      const userId = req.user.id

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const orgResult = await client.query<{
          id: string
          name: string
          slug: string
          createdAt: string
        }>(
          `INSERT INTO organizations (name, slug)
           VALUES ($1, $2)
           RETURNING id, name, slug,
                     to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt"`,
          [name, slug],
        )
        const org = orgResult.rows[0]!

        await client.query(
          `INSERT INTO org_members (org_id, user_id, role)
           VALUES ($1, $2, 'admin')`,
          [org.id, userId],
        )

        // Note: no writeAudit here — audit_log.subject_type is the
        // aiper_subject enum (project|folder|document); adding 'organization'
        // to that enum plus the resolver's chain-walk is out of scope for
        // this PR. Track as follow-up.

        await client.query('COMMIT')
        return reply.code(201).send(org)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'Slug already in use', code: 'duplicate_slug' })
        }
        throw err
      } finally {
        client.release()
      }
    },
  )
}

/** Postgres unique_violation SQLSTATE. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
