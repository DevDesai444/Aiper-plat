import { loadConfig, ConfigError } from './config.js'
import { buildServer } from './server.js'

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

  const app = await buildServer(config)
  await app.listen({ port: config.PORT, host: config.HOST })
  app.log.info(
    { port: config.PORT, host: config.HOST, jwtMode: config.SUPABASE_JWKS_URL ? 'jwks' : 'hs256' },
    'Aiper server listening',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
