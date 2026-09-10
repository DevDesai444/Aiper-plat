import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { registerOrgReadRoutes } from './orgs.js'
import { registerProjectReadRoutes } from './projects.js'
import { registerFolderReadRoutes } from './folders.js'
import { registerDocumentReadRoutes } from './documents.js'

/**
 * All hierarchy read routes — GETs on orgs, projects, folders, documents,
 * and comments. Every route is gated by aiper_effective_access from E1's
 * PR-3 with a 401 / 404 / 403 / 200 sequence (see common.ts for the
 * shared helper). PR-5 will add the WRITE counterparts under the same
 * subtree.
 */
export function registerHierarchyReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  registerOrgReadRoutes(app, pool)
  registerProjectReadRoutes(app, pool)
  registerFolderReadRoutes(app, pool)
  registerDocumentReadRoutes(app, pool)
}
