import 'dotenv/config'
import { loadConfig, ConfigError } from './config.js'
import { buildServer } from './server.js'
import { buildPool } from './db.js'

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

  if (!config.PGHOST || !config.PGUSER || !config.PGPASSWORD || !config.PGDATABASE) {
    console.error(
      'Missing required Postgres config: PGHOST, PGUSER, PGPASSWORD, PGDATABASE.\n' +
        'See apps/server/.env.example.',
    )
    process.exit(1)
  }

  const dbPort = config.PGPORT ?? 5432
  const pool = buildPool({
    host: config.PGHOST,
    port: dbPort,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    database: config.PGDATABASE,
  })

  const app = await buildServer(config, pool)
  await app.listen({ port: config.PORT, host: config.HOST })
  app.log.info(
    {
      port: config.PORT,
      host: config.HOST,
      jwtMode: config.SUPABASE_JWKS_URL ? 'jwks' : 'hs256',
      db: `${config.PGHOST}:${dbPort}/${config.PGDATABASE}`,
    },
    'Aiper server listening',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
