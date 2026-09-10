import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ApiErrorSchema, CommentSchema } from '@aiper/shared/schemas'
import { writeAudit } from '../../../audit.js'
import { ISO_UTC, printedName, resolveOrDenyForWrite, unauthorized } from './common.js'

const CommentCreateSchema = z.object({
  markId: z.string().min(1).max(128),
  quotedText: z.string().max(4_000).default(''),
  body: z.string().min(1).max(10_000),
})

const DocumentIdParams = z.object({ did: z.string().uuid() })
const DocumentAndMarkParams = z.object({
  did: z.string().uuid(),
  markId: z.string().min(1).max(128),
})

// SELECT projection shared by the create and resolve responses — one place
// to maintain when a new column joins the wire shape.
const COMMENT_RETURNING = `id,
                           document_id         AS "documentId",
                           mark_id             AS "markId",
                           COALESCE(quoted_text, '') AS "quotedText",
                           body,
                           author_id           AS "authorId",
                           author_display_name AS "authorDisplayName",
                           to_char(created_at  AT TIME ZONE 'UTC', ${ISO_UTC}) AS "createdAt",
                           to_char(resolved_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "resolvedAt",
                           resolved_by         AS "resolvedBy"`

export function registerCommentWriteRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // --------------------------------------------------------------- POST /documents/:did/comments
  //
  // Editor+ on the document. author_display_name is denormalised from the
  // caller's JWT at write time (see the header comment on migration 007
  // for the "old-name-in-old-comments" trade-off).
  typed.post(
    '/api/v1/documents/:did/comments',
    {
      schema: {
        summary: 'Add a comment anchored to a Yjs mark on the document',
        params: DocumentIdParams,
        body: CommentCreateSchema,
        response: {
          201: CommentSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did } = req.params
      const { markId, quotedText, body } = req.body
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'editor')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const created = await client.query(
          `INSERT INTO comments
             (document_id, mark_id, quoted_text, body, author_id, author_display_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${COMMENT_RETURNING}`,
          [did, markId, quotedText, body, userId, printedName(req.user)],
        )
        const comment = created.rows[0]!

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'comment.added',
          subjectType: 'document',
          subjectId: did,
          // Truncate quoted_text and body in audit — the audit log is not a
          // snapshot store; only enough context to identify the comment.
          newValue: {
            commentId: comment.id,
            markId,
            quotedTextPreview: (quotedText ?? '').slice(0, 200),
          },
        })

        await client.query('COMMIT')
        return reply.code(201).send(comment)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- POST /documents/:did/comments/:markId/resolve
  //
  // Marks every comment anchored to (did, markId) as resolved. Editor+
  // on the document. Idempotent — resolving an already-resolved thread
  // returns 200 with the current row(s) rather than erroring.
  typed.post(
    '/api/v1/documents/:did/comments/:markId/resolve',
    {
      schema: {
        summary: 'Mark all comments at a given Yjs mark as resolved',
        params: DocumentAndMarkParams,
        response: {
          200: z.object({ comments: z.array(CommentSchema) }),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return unauthorized(reply)
      const { did, markId } = req.params
      const userId = req.user.id

      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'editor')
      if (role === null) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Only touch rows that aren't already resolved — otherwise a
        // re-resolve would overwrite the original resolver + timestamp
        // and lose the audit trail's original entry.
        const updated = await client.query(
          `UPDATE comments
              SET resolved_at = now(),
                  resolved_by = $3
            WHERE document_id = $1
              AND mark_id     = $2
              AND resolved_at IS NULL
        RETURNING ${COMMENT_RETURNING}`,
          [did, markId, userId],
        )
        if (updated.rowCount === 0) {
          // Nothing needed changing. Return current rows so the client
          // has an accurate view without needing a second fetch.
          const current = await client.query(
            `SELECT ${COMMENT_RETURNING}
               FROM comments
              WHERE document_id = $1 AND mark_id = $2`,
            [did, markId],
          )
          if (current.rowCount === 0) {
            await client.query('ROLLBACK')
            return reply.code(404).send({ error: 'No such comment', code: 'not_found' })
          }
          await client.query('COMMIT')
          return { comments: current.rows }
        }

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'comment.resolved',
          subjectType: 'document',
          subjectId: did,
          newValue: { markId, resolvedCount: updated.rowCount },
        })

        await client.query('COMMIT')
        return { comments: updated.rows }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  )

  // --------------------------------------------------------------- DELETE /documents/:did/comments/:markId
  //
  // Author-or-owner: the commenter can delete their own thread; the
  // document's owner can delete anyone's. An editor of the document who
  // didn't author the thread gets 403 — otherwise editors could tidy
  // away comments from customers and reviewers.
  typed.delete(
    '/api/v1/documents/:did/comments/:markId',
    {
      schema: {
        summary: 'Delete comments anchored to a Yjs mark (author or doc owner)',
        params: DocumentAndMarkParams,
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
      const { did, markId } = req.params
      const userId = req.user.id

      // Editor+ is the baseline reach — the same-403-for-partial-access
      // guarantee lives here. Then we split on owner vs author-only inside.
      const role = await resolveOrDenyForWrite(pool, reply, userId, 'document', did, 'editor')
      if (role === null) return
      const isOwner = role === 'owner'

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const rows = await client.query<{ id: string; author_id: string }>(
          `SELECT id, author_id
             FROM comments
            WHERE document_id = $1 AND mark_id = $2
            FOR UPDATE`,
          [did, markId],
        )
        if (rows.rowCount === 0) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'No such comment', code: 'not_found' })
        }

        // Author check: caller must be author of every matching row when
        // they aren't the doc owner. Partial-authorship + delete-only-mine
        // is a UX trap (the client would see some rows disappear, others
        // remain, at one endpoint) so we refuse the delete atomically.
        if (!isOwner) {
          const notMine = rows.rows.find((r) => r.author_id !== userId)
          if (notMine) {
            await client.query('ROLLBACK')
            return reply.code(403).send({
              error: 'Only the author or the document owner can delete this comment.',
              code: 'not_author',
            })
          }
        }

        await client.query(
          `DELETE FROM comments WHERE document_id = $1 AND mark_id = $2`,
          [did, markId],
        )

        await writeAudit(client, {
          userId,
          printedName: printedName(req.user),
          action: 'comment.deleted',
          subjectType: 'document',
          subjectId: did,
          oldValue: { markId, deletedCount: rows.rowCount, byOwner: isOwner },
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
