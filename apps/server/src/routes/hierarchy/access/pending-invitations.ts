import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, AiperRoleSchema } from '@aiper/shared/schemas'
import type { AiperSubject } from '@aiper/shared/types'
import { ISO_UTC, resolveOrDenyForWrite, unauthorized } from '../writes/common.js'

const PendingInvitationSchema = z.object({
  email: z.string(),
  role: AiperRoleSchema,
  invitedAt: z.string().datetime({ offset: true }),
})
const PendingInvitationsResponseSchema = z.object({
  invitations: z.array(PendingInvitationSchema),
})

/**
 * Register `GET {basePath}/:{paramName}/invitations` for one subject type.
 *
 * Owner-only. Pending invites are sensitive — an invitee's email is not
 * information a mere editor of the subject should be able to enumerate.
 * The write-side companion (POST/DELETE invitations, from PR-5b) is also
 * owner-only, so the read matches.
 *
 * Returns only rows with principal_type='invite'. Once an invitee signs
 * in and provisionAndClaim converts the row to principal_type='user',
 * they show up under GET /members instead — this list is only the
 * outstanding-invite queue.
 */
export function registerPendingInvitationsReadRoute(
  app: FastifyInstance,
  pool: pg.Pool,
  subjectType: AiperSubject,
  paramName: 'pid' | 'fid' | 'did',
  basePath: string,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  const SubjectParams = z.object({ [paramName]: z.string().uuid() } as Record<string, z.ZodString>)

  typed.get(
    `${basePath}/:${paramName}/invitations`,
    {
      schema: {
        summary: `List pending (unclaimed) invitations on this ${subjectType}`,
        params: SubjectParams,
        response: {
          200: PendingInvitationsResponseSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const subjectId = (req.params as Record<string, string>)[paramName]!

      const role = await resolveOrDenyForWrite(
        pool,
        reply,
        req.user.id,
        subjectType,
        subjectId,
        'owner',
      )
      if (role === null) return

      const rows = await pool.query(
        `SELECT principal_id AS email,
                role,
                to_char(granted_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "invitedAt"
           FROM access_grants
          WHERE subject_type = $1::aiper_subject
            AND subject_id   = $2
            AND principal_type = 'invite'
          ORDER BY principal_id`,
        [subjectType, subjectId],
      )
      return { invitations: rows.rows }
    },
  )
}
