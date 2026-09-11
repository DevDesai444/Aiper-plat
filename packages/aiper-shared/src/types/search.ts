/**
 * Wire shape for GET /api/v1/search (and the project-scoped variant).
 *
 * A search result is a document reference plus the context needed to link
 * to it — project id + name (documents always belong to exactly one
 * project via their folder or a direct project parent), and folder id +
 * name when the document lives inside a folder. `myRole` is the caller's
 * effective access on the document; the server never returns a result
 * whose myRole is null (see the access filter in routes/search.ts).
 *
 * ILIKE-substring matching is what PR-6 ships; a full-text tsvector index
 * is the natural upgrade path when the dataset grows past a few thousand
 * documents. The wire shape stays the same across that migration.
 */

import type { AiperRole } from './index.js'
import type { DocumentKind } from './hierarchy.js'

export interface SearchResult {
  document: {
    id: string
    title: string
    kind: DocumentKind
  }
  project: {
    id: string
    name: string
  }
  /** Null when the document lives directly under the project (no folder). */
  folder: {
    id: string
    name: string
  } | null
  /** Caller's effective role on the document, never null in a search hit. */
  myRole: AiperRole
}

export interface SearchResponse {
  /** Results sorted by lower(title) ascending, capped at the requested limit. */
  results: SearchResult[]
}
