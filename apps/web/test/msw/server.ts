import { setupServer } from 'msw/node'
import { handlers } from './handlers'

/**
 * Node-side MSW server bound to the vitest lifecycle in ../setup.ts.
 * Each test overrides individual handlers with `server.use(...)`; the
 * default set below is the "happy path" for the two routes PR-1a exercises.
 */
export const server = setupServer(...handlers)
