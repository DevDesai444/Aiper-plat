import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { registerOrgWriteRoutes } from './orgs.js'
import { registerProjectWriteRoutes } from './projects.js'
import { registerFolderWriteRoutes } from './folders.js'
import { registerDocumentWriteRoutes } from './documents.js'

/**
 * All hierarchy domain write routes — POST + PATCH on orgs, projects,
 * folders, and documents. Every mutation runs in a transaction with a
 * paired writeAudit call so a domain change and its audit row either
 * both land or neither does.
 *
 * Access model:
 *   - Creates: caller needs editor+ on the parent (project for folder
 *     creation, folder for document creation, org membership for
 *     project creation).
 *   - Updates: caller needs editor+ on the subject itself. Owner-only
 *     thresholds for archive-style operations are a follow-up; PR-5a
 *     intentionally keeps a uniform "editor+" bar so the write surface
 *     lands as one review.
 *
 * Permissions/invitations and comment writes ship in follow-up PRs
 * (PR-5b, PR-5c) to stay under the review-size cap.
 */
export function registerHierarchyWriteRoutes(app: FastifyInstance, pool: pg.Pool): void {
  registerOrgWriteRoutes(app, pool)
  registerProjectWriteRoutes(app, pool)
  registerFolderWriteRoutes(app, pool)
  registerDocumentWriteRoutes(app, pool)
}
