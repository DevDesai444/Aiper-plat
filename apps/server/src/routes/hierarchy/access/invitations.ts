import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, AiperRoleSchema } from '@aiper/shared/schemas'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'
import { writeAudit } from '../../../audit.js'
import { printedName, resolveOrDenyForWrite, unauthorized } from '../writes/common.js'
import { normalizeEmail } from './common.js'

const InviteBodySchema = z.object({
  email: z.string().email().max(320),   // RFC 3696 practical max
  role: AiperRoleSchema,
})

const InviteResponseSchema = z.object({
  subjectType: z.enum(['project', 'folder', 'document']),
  subjectId: z.string().uuid(),
  role: AiperRoleSchema,
  /** True when the email matched an existing user and the grant landed
   *  as principal_type='user'; false when it was stored as an invite
   *  awaiting the invitee's first sign-in. */
  immediate: z.boolean(),
  /** The email that was written into access_grants (normalized). */
  email: z.string(),
})

/**
 * Two invitation routes for a single subject type:
 *
 *   POST   {basePath}/:{paramName}/invitations         body { email, role }
 *   DELETE {basePath}/:{paramName}/invitations/:email
 *
 * The write path is one of two shapes:
 *   - Email matches an existing users.email (case-insensitively). We UPSERT
 *     access_grants with principal_type='user' and principal_id=<that user's
 *     id>. The response's `immediate` is true.
 *   - No match. We UPSERT access_grants with principal_type='invite' and
 *     principal_id=lower(email). E1's provisionAndClaim (PR-5, already on
 *     main) converts the row to principal_type='user' on the invitee's
 *     first sign-in.
 *
 * The revoke path only deletes 'invite' rows — an established 'user' grant
 * comes off via DELETE /permissions/:userId. Deleting an invite that has
 * already been claimed would be a surprise; not our job.
 *
 * Owner-only; called three times from ./index.ts.
 */
export function registerInvitationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  subjectType: AiperSubject,
  paramName: 'pid' | 'fid' | 'did',
  basePath: string,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  const SubjectParams = z.object({ [paramName]: z.string().uuid() } as Record<string, z.ZodString>)
  const SubjectAndEmailParams = z.object({
    [paramName]: z.string().uuid(),
    email: z.string().email().max(320),
  } as Record<string, z.ZodString>)

  // -------------------------------------------------------------------- POST
  typed.post(
    `${basePath}/:${paramName}/invitations`,
    {
      schema: {
        summary: `Invite an email address to this ${subjectType}`,
        params: SubjectParams,
        body: InviteBodySchema,
        response: {
          200: InviteResponseSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const subjectId = (req.params as Record<string, string>)[paramName]!
      const { email, role } = req.body
      const actorId = req.user.id
      const normalized = normalizeEmail(email)

      const actorRole = await resolveOrDenyForWrite(
        pool,
        reply,
        actorId,
        subjectType,
        subjectId,
        'owner',
      )
      if (actorRole === null) return

      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = $1`,
        [normalized],
      )
      const immediate = existing.rowCount !== 0
      const targetPrincipalType = immediate ? 'user' : 'invite'
      const targetPrincipalId = immediate ? existing.rows[0]!.id : normalized

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Snapshot the current grant on this principal, for audit oldValue.
        const before = await client.query<{ role: AiperRole }>(
          `SELECT role FROM access_grants
            WHERE subject_type = $1::aiper_subject
              AND subject_id   = $2
              AND principal_type = $3
              AND principal_id   = $4
            FOR UPDATE`,
          [subjectType, subjectId, targetPrincipalType, targetPrincipalId],
        )
        const prevRole = before.rows[0]?.role ?? null

        await client.query(
          `INSERT INTO access_grants
             (subject_type, subject_id, principal_type, principal_id, role, granted_by)
           VALUES ($1::aiper_subject, $2, $3, $4, $5::aiper_role, $6)
           ON CONFLICT (subject_type, subject_id, principal_type, principal_id)
             DO UPDATE SET role = EXCLUDED.role,
                           granted_by = EXCLUDED.granted_by,
                           granted_at = now()`,
          [subjectType, subjectId, targetPrincipalType, targetPrincipalId, role, actorId],
        )

        await writeAudit(client, {
          userId: actorId,
          printedName: printedName(req.user),
          action: immediate ? 'permission.granted' : 'invitation.sent',
          subjectType,
          subjectId,
          oldValue: prevRole == null ? null : { email: normalized, role: prevRole, immediate },
          newValue: { email: normalized, role, immediate },
        })

        await client.query('COMMIT')
        return { subjectType, subjectId, role, immediate, email: normalized }
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
    `${basePath}/:${paramName}/invitations/:email`,
    {
      schema: {
        summary: `Revoke a pending invitation on this ${subjectType}`,
        params: SubjectAndEmailParams,
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
      const params = req.params as Record<string, string>
      const subjectId = params[paramName]!
      const rawEmail = params.email!
      const normalized = normalizeEmail(rawEmail)
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
              AND principal_type = 'invite'
              AND lower(principal_id) = $3
            FOR UPDATE`,
          [subjectType, subjectId, normalized],
        )
        if (before.rowCount === 0) {
          // Nothing pending under this email — idempotent success.
          await client.query('ROLLBACK')
          return reply.code(204).send(null)
        }
        const prevRole = before.rows[0]!.role

        await client.query(
          `DELETE FROM access_grants
            WHERE subject_type = $1::aiper_subject
              AND subject_id   = $2
              AND principal_type = 'invite'
              AND lower(principal_id) = $3`,
          [subjectType, subjectId, normalized],
        )

        await writeAudit(client, {
          userId: actorId,
          printedName: printedName(req.user),
          action: 'invitation.revoked',
          subjectType,
          subjectId,
          oldValue: { email: normalized, role: prevRole },
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
