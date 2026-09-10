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

  const pool = buildPool({
    host: config.PGHOST,
    port: config.PGPORT,
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
      db: `${config.PGHOST}:${config.PGPORT}/${config.PGDATABASE}`,
    },
    'Aiper server listening',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
