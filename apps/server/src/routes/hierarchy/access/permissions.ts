import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, AiperRoleSchema } from '@aiper/shared/schemas'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'
import { writeAudit } from '../../../audit.js'
import { printedName, resolveOrDenyForWrite, unauthorized } from '../writes/common.js'
import { wouldOrphanSubject } from './common.js'

const GrantBodySchema = z.object({
  userId: z.string().uuid(),
  role: AiperRoleSchema,
})

const GrantResponseSchema = z.object({
  subjectType: z.enum(['project', 'folder', 'document']),
  subjectId: z.string().uuid(),
  userId: z.string().uuid(),
  role: AiperRoleSchema,
})

/**
 * Register the two permission routes for a single subject type:
 *
 *   POST   {basePath}/:{paramName}/permissions        body { userId, role }
 *   DELETE {basePath}/:{paramName}/permissions/:userId
 *
 * Owner-only — a viewer or editor cannot grant, and cannot revoke either.
 * Same 403 code for "no grant" and "grant too low" so an editor probing
 * for owner-only actions cannot discover their partial access.
 *
 * Last-owner guard on both routes: refuse if the change would leave the
 * subject with zero user-owner grants. Adding another owner first is the
 * way through; the invited/promoted user must actually accept before that
 * takes effect (invites don't count until claimed).
 *
 * Called three times from ./index.ts — once per aiper_subject value.
 */
export function registerPermissionRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  subjectType: AiperSubject,
  paramName: 'pid' | 'fid' | 'did',
  basePath: string,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // params schemas are computed once per registration.
  const SubjectParams = z.object({ [paramName]: z.string().uuid() } as Record<string, z.ZodString>)
  const SubjectAndUserParams = z.object({
    [paramName]: z.string().uuid(),
    userId: z.string().uuid(),
  } as Record<string, z.ZodString>)

  // -------------------------------------------------------------------- POST
  typed.post(
    `${basePath}/:${paramName}/permissions`,
    {
      schema: {
        summary: `Grant or update a user's role on this ${subjectType}`,
        params: SubjectParams,
        body: GrantBodySchema,
        response: {
          200: GrantResponseSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const subjectId = (req.params as Record<string, string>)[paramName]!
      const { userId: targetUserId, role: nextRole } = req.body
      const actorId = req.user.id

      // Owner-only.
      const actorRole = await resolveOrDenyForWrite(
        pool,
        reply,
        actorId,
        subjectType,
        subjectId,
        'owner',
      )
      if (actorRole === null) return

      // Target must actually exist as a user — otherwise the FK on
      // access_grants.granted_by is fine but a grant for an unknown
      // principal is a silent bug.
      const target = await pool.query<{ display_name: string }>(
        `SELECT display_name FROM users WHERE id = $1`,
        [targetUserId],
      )
      if (target.rowCount === 0) {
        return reply.code(404).send({ error: 'No such user', code: 'user_not_found' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // What does the target hold on this subject right now? Needed for
        // the last-owner guard (and for a sensible audit oldValue).
        const currentGrant = await client.query<{ role: AiperRole }>(
          `SELECT role FROM access_grants
            WHERE subject_type = $1::aiper_subject
              AND subject_id   = $2
              AND principal_type = 'user'
              AND principal_id   = $3::text
            FOR UPDATE`,
          [subjectType, subjectId, targetUserId],
        )
        const prevRole = (currentGrant.rows[0]?.role ?? null) as AiperRole | null

        if (await wouldOrphanSubject(client, subjectType, subjectId, prevRole, nextRole)) {
          await client.query('ROLLBACK')
          return reply.code(409).send({
            error: 'This is the only owner. Add another owner first.',
            code: 'last_owner',
          })
        }

        await client.query(
          `INSERT INTO access_grants
             (subject_type, subject_id, principal_type, principal_id, role, granted_by)
           VALUES ($1::aiper_subject, $2, 'user', $3::text, $4::aiper_role, $5)
           ON CONFLICT (subject_type, subject_id, principal_type, principal_id)
             DO UPDATE SET role = EXCLUDED.role,
                           granted_by = EXCLUDED.granted_by,
                           granted_at = now()`,
          [subjectType, subjectId, targetUserId, nextRole, actorId],
        )

        await writeAudit(client, {
          userId: actorId,
          printedName: printedName(req.user),
          action: 'permission.granted',
          subjectType,
          subjectId,
          oldValue: prevRole == null ? null : { userId: targetUserId, role: prevRole },
          newValue: { userId: targetUserId, role: nextRole },
        })

        await client.query('COMMIT')
        return { subjectType, subjectId, userId: targetUserId, role: nextRole }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // ------------------------------------------------------------------ DELETE
  typed.delete(
    `${basePath}/:${paramName}/permissions/:userId`,
    {
      schema: {
        summary: `Revoke a user's direct grant on this ${subjectType}`,
        params: SubjectAndUserParams,
        response: {
          204: z.null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const params = req.params as Record<string, string>
      const subjectId = params[paramName]!
      const targetUserId = params.userId!
      const actorId = req.user.id

      const actorRole = await resolveOrDenyForWrite(
        pool,
        reply,
        actorId,
        subjectType,
        subjectId,
        'owner',
      )
      if (actorRole === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{ role: AiperRole }>(
          `SELECT role FROM access_grants
            WHERE subject_type = $1::aiper_subject
              AND subject_id   = $2
              AND principal_type = 'user'
              AND principal_id   = $3::text
            FOR UPDATE`,
          [subjectType, subjectId, targetUserId],
        )
        if (before.rowCount === 0) {
          // Idempotent-friendly — nothing to revoke. Treat as success so
          // repeated DELETEs after a UI double-click don't error.
          await client.query('ROLLBACK')
          return reply.code(204).send(null)
        }
        const prevRole = before.rows[0]!.role

        if (await wouldOrphanSubject(client, subjectType, subjectId, prevRole, null)) {
          await client.query('ROLLBACK')
          return reply.code(409).send({
            error: 'This is the only owner. Add another owner first.',
            code: 'last_owner',
          })
        }

        await client.query(
          `DELETE FROM access_grants
            WHERE subject_type = $1::aiper_subject
              AND subject_id   = $2
              AND principal_type = 'user'
              AND principal_id   = $3::text`,
          [subjectType, subjectId, targetUserId],
        )

        await writeAudit(client, {
          userId: actorId,
          printedName: printedName(req.user),
          action: 'permission.revoked',
          subjectType,
          subjectId,
          oldValue: { userId: targetUserId, role: prevRole },
          newValue: null,
        })

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
