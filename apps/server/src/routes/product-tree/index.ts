import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { registerProductTreeReadRoutes } from './reads.js'

/**
 * Product-tree routes — see ./reads.ts and (queued for PR-D) ./writes.ts.
 * Every route is gated by aiper_effective_access on the parent project;
 * 404-existence-hiding matches the E3 convention on save flow and history.
 */
export function registerProductTreeRoutes(app: FastifyInstance, pool: pg.Pool): void {
  registerProductTreeReadRoutes(app, pool)
}
