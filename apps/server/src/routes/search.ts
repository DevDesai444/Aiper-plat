import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  ApiErrorSchema,
  SearchResponseSchema,
} from '@aiper/shared/schemas'
import type { AiperRole, DocumentKind } from '@aiper/shared/types'

/**
 * Document title search — case-insensitive substring match (`ILIKE`) filtered
 * through `aiper_effective_access` so results never leak a document the caller
 * cannot see. Same existence-hiding shape as every other read route: a
 * document the caller lacks access to is simply absent from the results,
 * not returned with an error.
 *
 * MVP is `ILIKE '%q%'`. The natural upgrade is a `tsvector` GIN index +
 * `plainto_tsquery` when the corpus grows past a few thousand documents;
 * the wire shape from ../shared/types/search.ts is chosen so that swap
 * doesn't change the API — only the WHERE clause changes.
 *
 * Two variants share the same handler shape:
 *   GET /api/v1/search?q=&limit=              — everywhere the caller can reach
 *   GET /api/v1/projects/:pid/search?q=&limit= — narrowed to one project
 *
 * The project-scoped variant still runs the same resolver filter — a viewer
 * of the project won't see a document under a subtree they can't reach.
 */

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const ProjectScopedParams = z.object({ pid: z.string().uuid() })

// Every document's parent context (project id/name, optional folder id/name)
// is joined once in SQL rather than N+1'd in JS; the resolver call runs per
// row inside Postgres so a single round-trip returns everything the client
// needs.
const SEARCH_SELECT = `
  SELECT d.id                     AS doc_id,
         d.title                  AS doc_title,
         d.kind                   AS doc_kind,
         COALESCE(f.id, NULL)     AS folder_id,
         COALESCE(f.name, NULL)   AS folder_name,
         COALESCE(pf.id, pp.id)   AS project_id,
         COALESCE(pf.name, pp.name) AS project_name,
         aiper_effective_access($1, 'document', d.id) AS my_role
    FROM documents d
    LEFT JOIN folders  f  ON f.id  = d.folder_id
    LEFT JOIN projects pf ON pf.id = f.project_id
    LEFT JOIN projects pp ON pp.id = d.project_id
`

interface SearchRow {
  doc_id: string
  doc_title: string
  doc_kind: DocumentKind
  folder_id: string | null
  folder_name: string | null
  project_id: string
  project_name: string
  my_role: AiperRole | null
}

function toResult(row: SearchRow) {
  return {
    document: { id: row.doc_id, title: row.doc_title, kind: row.doc_kind },
    project:  { id: row.project_id, name: row.project_name },
    folder:   row.folder_id ? { id: row.folder_id, name: row.folder_name! } : null,
    myRole:   row.my_role as AiperRole,
  }
}

/**
 * Postgres LIKE wildcards inside the user's search term — `%` matches any
 * substring, `_` matches any single char, `\` escapes — would let a
 * caller trick the query into unintended matches. Not a security issue
 * (results still filter through the access resolver), but a UX one: a
 * user typing `50%` should search for "50%", not "50-then-anything".
 * Escape the three wildcards; ILIKE with the escaped pattern behaves
 * exactly like the user typed.
 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function registerSearchRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  // ------------------------------------------------------------------ global search
  typed.get(
    '/api/v1/search',
    {
      schema: {
        summary: 'Search documents by title (ILIKE substring), access-filtered',
        querystring: SearchQuerySchema,
        response: {
          200: SearchResponseSchema,
          401: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
      }
      const { q, limit } = req.query
      const like = `%${escapeLike(q)}%`

      const rows = await pool.query<SearchRow>(
        `${SEARCH_SELECT}
          WHERE d.title ILIKE $2 ESCAPE '\\'
            AND aiper_effective_access($1, 'document', d.id) IS NOT NULL
          ORDER BY lower(d.title)
          LIMIT $3`,
        [req.user.id, like, limit],
      )
      return { results: rows.rows.map(toResult) }
    },
  )

  // ------------------------------------------------------------------ project-scoped search
  typed.get(
    '/api/v1/projects/:pid/search',
    {
      schema: {
        summary: 'Search documents in a project by title, access-filtered',
        params: ProjectScopedParams,
        querystring: SearchQuerySchema,
        response: {
          200: SearchResponseSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: 'Not signed in', code: 'no_session' })
      }
      const { pid } = req.params
      const { q, limit } = req.query
      const like = `%${escapeLike(q)}%`

      // Existence check on the project — 404 for a random uuid keeps the
      // existence-hiding rule the rest of the API follows. A caller with
      // no access to any doc in the project still gets 200 with results:[]
      // (the resolver filter does that below), which is fine — knowing
      // the project exists is already implied by the id being in the URL.
      const exists = await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [pid])
      if (exists.rowCount === 0) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' })
      }

      const rows = await pool.query<SearchRow>(
        `${SEARCH_SELECT}
          WHERE d.title ILIKE $2 ESCAPE '\\'
            AND aiper_effective_access($1, 'document', d.id) IS NOT NULL
            AND COALESCE(f.project_id, d.project_id) = $4
          ORDER BY lower(d.title)
          LIMIT $3`,
        [req.user.id, like, limit, pid],
      )
      return { results: rows.rows.map(toResult) }
    },
  )
}
