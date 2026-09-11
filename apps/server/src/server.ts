import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import type pg from 'pg'
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'

import type { Config } from './config.js'
import { buildVerifier } from './auth/jwt.js'
import { registerAuthMiddleware } from './auth/middleware.js'
import { registerHealthRoute } from './routes/health.js'
import { registerMeRoute } from './routes/me.js'
import { registerAuditRoute } from './routes/audit.js'
import { registerAuthAdminRoute } from './routes/auth-admin.js'
import { registerHierarchyReadRoutes } from './routes/hierarchy/index.js'
import { registerHierarchyWriteRoutes } from './routes/hierarchy/writes/index.js'
import { registerAccessRoutes } from './routes/hierarchy/access/index.js'
import { registerSaveFlowRoutes } from './routes/save-flow.js'
import { registerHistoryRoute } from './routes/history.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerDocumentLinkRoutes } from './routes/doc-links.js'
import { registerWsRoutes } from './ws/index.js'
import { reqSerializer } from './log-serializers.js'
import pkg from '../package.json' with { type: 'json' }

/**
 * Build a fully-wired Fastify instance. Exported (rather than starting
 * the listen inside index.ts) so tests can `await buildServer(config,
 * pool)` and hit routes with `app.inject(...)` — no port bind, no
 * cleanup.
 *
 * `pool` is required as of PR-6 — every route the server exposes now
 * touches the DB (health probes it, /me and /audit read it, middleware
 * writes to it). Tests use `setupTestDb()` to get a pool; unit tests
 * that want to fake a failure can pass a pool wired to a bad port.
 */
export async function buildServer(config: Config, pool: pg.Pool): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
      // Override the default `req` serialiser to strip ?token= from
      // every URL log line. The WS upgrade for /ws carries the
      // Supabase JWT in its query (browsers cannot set Authorization
      // on a WebSocket) and Fastify logs req.url at info by default;
      // without this the bearer lands in the log store on every
      // connect. See log-serializers.ts for the implementation and
      // its unit test.
      serializers: { req: reqSerializer },
    },
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(cors, { origin: true, credentials: true })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Aiper Server API',
        version: pkg.version,
        description:
          'Aiper platform REST API. All routes live under /api/v1. Auth is a Supabase-issued JWT in the Authorization header.',
      },
      servers: [{ url: `http://${config.HOST}:${config.PORT}` }],
    },
    transform: jsonSchemaTransform,
  })

  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  registerAuthMiddleware(app, buildVerifier(config), pool)
  registerHealthRoute(app, pool)
  registerMeRoute(app)
  registerAuthAdminRoute(app, config)
  registerAuditRoute(app, pool)
  registerHierarchyReadRoutes(app, pool)
  registerHierarchyWriteRoutes(app, pool)
  registerAccessRoutes(app, pool)
  registerSaveFlowRoutes(app, pool)
  registerHistoryRoute(app, pool)
  registerSearchRoutes(app, pool)
  registerDocumentLinkRoutes(app, pool)
  registerWsRoutes(app, pool, config)

  return app
}
