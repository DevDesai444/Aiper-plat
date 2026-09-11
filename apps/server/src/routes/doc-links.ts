import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  DocumentLinkCreateInputSchema,
  DocumentLinkSchema,
  DocumentLinksResponseSchema,
} from '@aiper/shared/schemas'
import type {
  AiperRole,
  DocumentKind,
  DocumentLinkRelation,
} from '@aiper/shared/types'
import { writeAudit } from '../audit.js'
import { ISO_UTC, printedName, resolveOrDenyForWrite, unauthorized } from './hierarchy/writes/common.js'

/**
 * Directed traceability links between two documents. See migration 011 for
 * the storage shape and design/E2-doc-links.md for the design decisions
 * behind the vocabulary and access model.
 *
 * Cross-project links are permitted; the visibility filter on read hides
 * rows whose counterpart the caller no longer has access to. Audit is
 * anchored to the SOURCE document (audit_log.subject_type is the
 * aiper_subject enum — no 'document_link' variant — and the source's
 * history is the canonical record of "this doc claims X about Y").
 */

const DocumentIdParams = z.object({ did: z.string().uuid() })
const DocumentAndLinkIdParams = z.object({
  did: z.string().uuid(),
  linkId: z.string().uuid(),
})

// Row shape returned by the counterpart-joined SELECT. Both outgoing and
// incoming reads project this exact shape — only the JOIN target
// (target_document_id vs source_document_id) differs. Kept in one type so
// the mapping to DocumentLink is written once.
interface LinkRow {
  id: string
  relation: DocumentLinkRelation
  created_by: string
  created_at: string
  counterpart_id: string
  counterpart_title: string
  counterpart_kind: DocumentKind
  counterpart_project_id: string
  counterpart_project_name: string
  counterpart_role: AiperRole | null
}

function toDocumentLink(row: LinkRow) {
  return {
    id: row.id,
    relation: row.relation,
    counterpart: {
      id: row.counterpart_id,
      title: row.counterpart_title,
      kind: row.counterpart_kind,
      projectId: row.counterpart_project_id,
      projectName: row.counterpart_project_name,
    },
    createdBy: row.created_by,
    createdAt: row.created_at,
    counterpartRole: row.counterpart_role as AiperRole,
  }
}

// One SELECT template used twice (outgoing / incoming). The parameter list
// is (user_id, source_or_target_id) — the callers pass which side of the
// link they're anchoring by choosing the right column in the WHERE.
function linkListSql(direction: 'outgoing' | 'incoming'): string {
  const anchor = direction === 'outgoing' ? 'l.source_document_id' : 'l.target_document_id'
  const otherEnd = direction === 'outgoing' ? 'l.target_document_id' : 'l.source_document_id'
  return `
    SELECT l.id,
           l.relation,
           l.created_by,
           to_char(l.created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS created_at,
           d.id                        AS counterpart_id,
           d.title                     AS counterpart_title,
           d.kind                      AS counterpart_kind,
           COALESCE(pf.id, pp.id)      AS counterpart_project_id,
           COALESCE(pf.name, pp.name)  AS counterpart_project_name,
           aiper_effective_access($1, 'document', d.id) AS counterpart_role
      FROM document_links l
      JOIN documents d  ON d.id = ${otherEnd}
      LEFT JOIN folders  f  ON f.id  = d.folder_id
      LEFT JOIN projects pf ON pf.id = f.project_id
      LEFT JOIN projects pp ON pp.id = d.project_id
     WHERE ${anchor} = $2
     ORDER BY lower(d.title)`
}

export function registerDocumentLinkRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // -------------------------------------------------------------- POST /links
  //
  // Create a link. editor+ on source (this is a content-adjacent write on
  // the source doc's outbound claims), viewer+ on target (no linking to
  // what you can't see — matches the existence-hiding rule).
  typed.post(
    '/api/v1/documents/:did/links',
    {
      schema: {
        summary: 'Create a directed traceability link from this document to another',
        params: DocumentIdParams,
        body: DocumentLinkCreateInputSchema,
        response: {
          201: DocumentLinkSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did } = req.params
      const { targetDocumentId, relation } = req.body
      const userId = req.user.id

      // Self-link short-circuit before hitting the CHECK constraint gives
      // a cleaner error than the raw 23514.
      if (targetDocumentId === did) {
        return reply.code(400).send({
          error: 'A document cannot link to itself',
          code: 'self_link',
        })
      }

      const sourceRole = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'editor')
      if (sourceRole === null) return
      const targetRole = await resolveOrDenyForWrite(pool, reply, userId, 'document', targetDocumentId, 'viewer')
      if (targetRole === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        let insertedId: string
        let createdAt: string
        try {
          const created = await client.query<{ id: string; created_at: string }>(
            `INSERT INTO document_links (source_document_id, target_document_id, relation, created_by)
               VALUES ($1, $2, $3, $4)
             RETURNING id,
                       to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS created_at`,
            [did, targetDocumentId, relation, userId],
          )
          insertedId = created.rows[0]!.id
          createdAt = created.rows[0]!.created_at
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          // Duplicate (source, target, relation) triple → the DB uniqueness
          // constraint fires; surface as 409 with a clear code.
          if (isUniqueViolation(err)) {
            return reply.code(409).send({
              error: 'This link already exists',
              code: 'duplicate_link',
            })
          }
          throw err
        }

        // Fetch counterpart summary so the response is a full DocumentLink
        // (matches the GET row shape — clients can stitch it into a list
        // without a second round-trip).
        const counterpart = await client.query<{
          id: string
          title: string
          kind: DocumentKind
          projectId: string
          projectName: string
        }>(
          `SELECT d.id,
                  d.title,
                  d.kind,
                  COALESCE(pf.id, pp.id)     AS "projectId",
                  COALESCE(pf.name, pp.name) AS "projectName"
             FROM documents d
             LEFT JOIN folders  f  ON f.id  = d.folder_id
             LEFT JOIN projects pf ON pf.id = f.project_id
             LEFT JOIN projects pp ON pp.id = d.project_id
            WHERE d.id = $1`,
          [targetDocumentId],
        )
        const cp = counterpart.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'doc-link.created',
          subjectType: 'document',
          subjectId: did,
          newValue: { targetDocumentId, relation },
        })

        await client.query('COMMIT')
        return reply.code(201).send({
          id: insertedId,
          relation,
          counterpart: {
            id: cp.id,
            title: cp.title,
            kind: cp.kind,
            projectId: cp.projectId,
            projectName: cp.projectName,
          },
          createdBy: userId,
          createdAt,
          counterpartRole: targetRole,
        })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // -------------------------------------------------------------- DELETE /links/:linkId
  //
  // Remove a link. editor+ on the SOURCE document — the target's owner
  // cannot delete inbound arrows they didn't create (that would let a
  // viewer of a doc unilaterally rewrite the source's outbound claims).
  // Idempotent: a delete for a link_id that doesn't match (source=:did,
  // id=:linkId) returns 204 rather than 404 so a UI's double-click after
  // a successful delete doesn't error.
  typed.delete(
    '/api/v1/documents/:did/links/:linkId',
    {
      schema: {
        summary: 'Delete a traceability link (editor+ on source)',
        params: DocumentAndLinkIdParams,
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
      const { did, linkId } = req.params
      const userId = req.user.id

      const sourceRole = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'editor')
      if (sourceRole === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const before = await client.query<{
          target_document_id: string
          relation: DocumentLinkRelation
        }>(
          `SELECT target_document_id, relation
             FROM document_links
            WHERE id = $1 AND source_document_id = $2
            FOR UPDATE`,
          [linkId, did],
        )
        if (before.rowCount === 0) {
          // Either the link never existed, or its source is a different
          // document. Either way, nothing to remove — idempotent 204 so
          // a UI-race double-click is not surfaced as an error.
          await client.query('ROLLBACK')
          return reply.code(204).send(null)
        }

        await client.query(
          `DELETE FROM document_links WHERE id = $1 AND source_document_id = $2`,
          [linkId, did],
        )

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'doc-link.deleted',
          subjectType: 'document',
          subjectId: did,
          oldValue: {
            targetDocumentId: before.rows[0]!.target_document_id,
            relation: before.rows[0]!.relation,
          },
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

  // -------------------------------------------------------------- GET /links
  //
  // Two-list envelope: outgoing (this doc points at these) and incoming
  // (these point at this doc). viewer+ on the doc; each row filtered by
  // whether the caller can also see the counterpart, so a later access
  // loss on the other end silently drops the row rather than 500-ing on
  // a serialization failure or leaking a hidden doc's metadata.
  typed.get(
    '/api/v1/documents/:did/links',
    {
      schema: {
        summary: 'List outgoing + incoming traceability links for a document',
        params: DocumentIdParams,
        response: {
          200: DocumentLinksResponseSchema,
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

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'viewer')
      if (role === null) return

      const outgoing = await pool.query<LinkRow>(linkListSql('outgoing'), [userId, did])
      const incoming = await pool.query<LinkRow>(linkListSql('incoming'), [userId, did])

      return {
        outgoing: outgoing.rows
          .filter((r) => r.counterpart_role !== null)
          .map(toDocumentLink),
        incoming: incoming.rows
          .filter((r) => r.counterpart_role !== null)
          .map(toDocumentLink),
      }
    },
  )
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
