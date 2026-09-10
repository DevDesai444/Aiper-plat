import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { registerPermissionRoutes } from './permissions.js'
import { registerInvitationRoutes } from './invitations.js'

/**
 * All access-management routes: 12 endpoints across 3 subject types
 * (project / folder / document), each with permission grant / revoke and
 * invitation send / revoke. Both factories run three times below with
 * subject-specific route segments and param names.
 *
 * Every route is OWNER-only on the subject (requirement 6) and calls
 * writeAudit inside its transaction. The last-owner guard lives in the
 * factories, not here — see access/common.ts::wouldOrphanSubject.
 */
export function registerAccessRoutes(app: FastifyInstance, pool: pg.Pool): void {
  registerPermissionRoutes(app, pool, 'project',  'pid', '/api/v1/projects')
  registerPermissionRoutes(app, pool, 'folder',   'fid', '/api/v1/folders')
  registerPermissionRoutes(app, pool, 'document', 'did', '/api/v1/documents')

  registerInvitationRoutes(app, pool, 'project',  'pid', '/api/v1/projects')
  registerInvitationRoutes(app, pool, 'folder',   'fid', '/api/v1/folders')
  registerInvitationRoutes(app, pool, 'document', 'did', '/api/v1/documents')
}
