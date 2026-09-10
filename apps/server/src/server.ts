import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
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
import pkg from '../package.json' with { type: 'json' }

/**
 * Build a fully-wired Fastify instance. Exported (rather than starting the
 * listen inside index.ts) so tests can `await buildServer(config)` and hit
 * routes with `app.inject(...)` — no port bind, no cleanup ceremony.
 */
export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Prettify in dev only when we can pull pino-pretty in; production
      // stays as newline-delimited JSON that any log aggregator can eat.
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

  // Serve the raw JSON spec at the canonical path (rather than @fastify/swagger's
  // default /documentation/json, which we don't want in the public URL space).
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  registerAuthMiddleware(app, buildVerifier(config))
  registerHealthRoute(app)
  registerMeRoute(app)

  return app
}
