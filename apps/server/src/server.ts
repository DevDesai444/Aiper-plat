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
import pkg from '../package.json' with { type: 'json' }

/**
 * Build a fully-wired Fastify instance. Exported (rather than starting
 * the listen inside index.ts) so tests can `await buildServer(config)`
 * and hit routes with `app.inject(...)` — no port bind, no cleanup.
 *
 * `pool` is optional so non-DB tests (health, me, jwt, config) do not
 * have to invent one; the audit route registers only when a pool is
 * supplied. In production, `index.ts` always passes a real pool.
 */
export async function buildServer(config: Config, pool?: pg.Pool): Promise<FastifyInstance> {
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

  registerAuthMiddleware(app, buildVerifier(config))
  registerHealthRoute(app)
  registerMeRoute(app)
  if (pool) registerAuditRoute(app, pool)

  return app
}
