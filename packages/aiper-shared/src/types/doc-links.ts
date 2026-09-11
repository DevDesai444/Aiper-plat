/**
 * Wire shape for POST/DELETE/GET /api/v1/documents/:did/links.
 *
 * Directed traceability links between two documents. See migration 011 for
 * the storage shape; the vocabulary here MUST match the CHECK constraint
 * on document_links.relation exactly. Extending: add the new value here
 * AND in migration N (drop-and-recreate the CHECK).
 *
 * `DocumentLink` is the read shape returned in both directions of the
 * GET listing — a single row from the caller's perspective always looks
 * the same, with `counterpart` being the *other* document.
 */

import type { AiperRole } from './index.js'
import type { DocumentKind } from './hierarchy.js'

export type DocumentLinkRelation =
  | 'verifies'
  | 'references'
  | 'derives-from'
  | 'supersedes'
  | 'conflicts-with'

/**
 * Trimmed reference to the document at the other end of a link. Enough for
 * the UI to render a row ("TVAC Report Rev 2 — MISSION-X") and offer a
 * link that opens it; a full document GET is one round-trip away.
 */
export interface DocumentLinkEndpoint {
  id: string
  title: string
  kind: DocumentKind
  /** Project the counterpart lives in — renders "<title> in <projectName>" in the UI. */
  projectId: string
  projectName: string
}

export interface DocumentLink {
  id: string
  relation: DocumentLinkRelation
  /** The other end of the link, from the perspective of the doc being read. */
  counterpart: DocumentLinkEndpoint
  createdBy: string
  createdAt: string   // ISO 8601 with offset
  /**
   * Caller's effective role on the COUNTERPART. Populated so the UI can
   * disable "open" for a viewer even before they click. Never null — the
   * server omits rows whose counterpart the caller cannot view.
   */
  counterpartRole: AiperRole
}

/**
 * Response for GET /api/v1/documents/:did/links.
 *   outgoing: this document points at these
 *   incoming: these documents point at this one
 * Both lists are filtered by counterpart visibility.
 */
export interface DocumentLinksResponse {
  outgoing: DocumentLink[]
  incoming: DocumentLink[]
}

/** POST body — the URL carries the source; body carries the target + relation. */
export interface DocumentLinkCreateInput {
  targetDocumentId: string
  relation: DocumentLinkRelation
}
