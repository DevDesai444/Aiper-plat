import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, AiperRoleSchema } from '@aiper/shared/schemas'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'
import { resolveOrDenyForWrite, unauthorized } from '../writes/common.js'

const MemberSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
  role: AiperRoleSchema,
  /** True when the caller only reaches this subject via a grant on an
   *  ancestor (project → folder → document walk), not a direct grant on
   *  the subject itself. Shown so an owner can see the full access list,
   *  not only the local one. */
  inherited: z.boolean(),
})
const MembersResponseSchema = z.object({ members: z.array(MemberSchema) })

/**
 * Register `GET {basePath}/:{paramName}/members` for one subject type.
 *
 * Viewer+ on the subject — anyone who can read this subject can see who
 * else has access. Owners see the same list; the write side (add/remove)
 * is what's owner-only.
 *
 * Result composition:
 *   1. Directly granted users on this subject (principal_type='user',
 *      subject_type/subject_id match this exact row) — inherited=false.
 *   2. Every other user in the same organization who resolves to a role
 *      via aiper_effective_access — inherited=true. Bounded to org
 *      members so the query does not walk every user in the database;
 *      cross-org grants (rare) are covered by (1) because the direct-
 *      grant rows still surface. If a future access model allows grants
 *      to non-members, this can grow a UNION on
 *      access_grants-along-the-chain.
 *
 * Called three times from ./index.ts.
 */
export function registerMembersReadRoute(
  app: FastifyInstance,
  pool: pg.Pool,
  subjectType: AiperSubject,
  paramName: 'pid' | 'fid' | 'did',
  basePath: string,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  const SubjectParams = z.object({ [paramName]: z.string().uuid() } as Record<string, z.ZodString>)

  typed.get(
    `${basePath}/:${paramName}/members`,
    {
      schema: {
        summary: `List members with access to this ${subjectType} (direct + inherited)`,
        params: SubjectParams,
        response: {
          200: MembersResponseSchema,
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
        'viewer',
      )
      if (role === null) return

      // Which org owns this subject? Same subject_type/subject_id lookup
      // that would be a JOIN if the tables were homogeneous. Kept in a
      // small switch rather than a CASE in SQL so each variant is easy
      // to read.
      const orgId = await getSubjectOrgId(pool, subjectType, subjectId)
      if (orgId === null) {
        // Should not happen — the resolver just returned a role, so the
        // subject exists. Belt-and-braces empty response.
        return { members: [] }
      }

      // Query: for every candidate user (org member + anyone with a
      // direct grant on this subject, to catch cross-org edge cases),
      // compute effective role and whether they hold a direct grant.
      const rows = await pool.query<{
        id: string
        displayName: string
        email: string
        role: AiperRole | null
        isDirect: boolean
      }>(
        `WITH candidates AS (
           SELECT user_id FROM org_members WHERE org_id = $1
           UNION
           SELECT principal_id::uuid FROM access_grants
            WHERE subject_type = $2::aiper_subject
              AND subject_id   = $3
              AND principal_type = 'user'
         )
         SELECT u.id,
                u.display_name AS "displayName",
                u.email,
                aiper_effective_access(u.id, $2::aiper_subject, $3) AS role,
                EXISTS (
                  SELECT 1 FROM access_grants
                   WHERE subject_type = $2::aiper_subject
                     AND subject_id   = $3
                     AND principal_type = 'user'
                     AND principal_id   = u.id::text
                ) AS "isDirect"
           FROM users u
           JOIN candidates c ON c.user_id = u.id
          ORDER BY u.display_name`,
        [orgId, subjectType, subjectId],
      )

      const members = rows.rows
        .filter((r) => r.role !== null)
        .map((r) => ({
          userId: r.id,
          displayName: r.displayName,
          email: r.email,
          role: r.role as AiperRole,
          inherited: !r.isDirect,
        }))

      return { members }
    },
  )
}

/**
 * Look up the org that owns a subject. Different join per subject type;
 * kept as a small switch rather than a polymorphic query.
 */
async function getSubjectOrgId(
  pool: pg.Pool,
  subjectType: AiperSubject,
  subjectId: string,
): Promise<string | null> {
  if (subjectType === 'project') {
    const r = await pool.query<{ org_id: string }>(
      `SELECT org_id FROM projects WHERE id = $1`,
      [subjectId],
    )
    return r.rows[0]?.org_id ?? null
  }
  if (subjectType === 'folder') {
    const r = await pool.query<{ org_id: string }>(
      `SELECT p.org_id
         FROM folders f JOIN projects p ON p.id = f.project_id
        WHERE f.id = $1`,
      [subjectId],
    )
    return r.rows[0]?.org_id ?? null
  }
  // document: folder_id OR project_id is set (never both) per commit 493003e.
  const r = await pool.query<{ org_id: string }>(
    `SELECT COALESCE(pp.org_id, pf.org_id) AS org_id
       FROM documents d
       LEFT JOIN projects pp ON pp.id = d.project_id
       LEFT JOIN folders  f  ON f.id  = d.folder_id
       LEFT JOIN projects pf ON pf.id = f.project_id
      WHERE d.id = $1`,
    [subjectId],
  )
  return r.rows[0]?.org_id ?? null
}
