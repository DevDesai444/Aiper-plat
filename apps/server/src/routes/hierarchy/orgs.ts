import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  OrganizationSchema,
  ProjectSchema,
} from '@aiper/shared/schemas'
import { unauthorized } from './common.js'

const OrgListResponse = z.object({ items: z.array(OrganizationSchema) })
const ProjectListResponse = z.object({ items: z.array(ProjectSchema) })

const OrgIdParams = z.object({ oid: z.string().uuid() })

export function registerOrgReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // Orgs the caller is a member of. Org membership is read straight off
  // req.user.orgMemberships (populated by the auth middleware from
  // org_members in E1's PR-5) — no separate access-grants check.
  typed.get(
    '/api/v1/orgs',
    {
      schema: {
        summary: 'List organizations the caller is a member of',
        response: {
          200: OrgListResponse,
          401: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const orgIds = req.user.orgMemberships.map((m) => m.orgId)
      if (orgIds.length === 0) return { items: [] }
      const rows = await pool.query(
        `SELECT id, name, slug,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM organizations
          WHERE id = ANY($1::uuid[])
          ORDER BY name`,
        [orgIds],
      )
      return { items: rows.rows }
    },
  )

  // Projects inside an org that the caller can reach. Existence check on
  // the org first (404 rather than 403 for a random uuid), then membership
  // (403 if not a member), then the reachable-project filter via the
  // resolver. Non-members get 403 rather than a masked-empty list so a
  // caller who accidentally holds a stale org id sees the failure clearly.
  typed.get(
    '/api/v1/orgs/:oid/projects',
    {
      schema: {
        summary: "List projects in an org the caller can reach",
        params: OrgIdParams,
        response: {
          200: ProjectListResponse,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { oid } = req.params

      const exists = await pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [oid])
      if (exists.rowCount === 0) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }

      const isMember = req.user.orgMemberships.some((m) => m.orgId === oid)
      if (!isMember) {
        return reply.code(403).send({ error: 'No access', code: 'no_access' })
      }

      // Projects the caller has ANY role on (owner > editor > viewer via
      // aiper_effective_access). Unreachable projects are dropped rather
      // than returned with myRole:null — the shape stays a clean list of
      // things the caller can actually open.
      const rows = await pool.query(
        `SELECT p.id,
                p.org_id     AS "orgId",
                p.name,
                p.slug,
                p.created_by AS "createdBy",
                to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
                aiper_effective_access($1, 'project', p.id) AS "myRole"
           FROM projects p
          WHERE p.org_id = $2
          ORDER BY p.name`,
        [req.user.id, oid],
      )
      const items = rows.rows.filter((r) => r.myRole !== null)
      return { items }
    },
  )
}
