import pg from 'pg'

/** Everything a pg Pool needs. Kept separate from the whole server Config
 *  so tests that want a pool don't have to construct a JWT config too. */
export interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/**
 * Build a pg Pool with sensible defaults for a long-running server:
 *   max 10 connections, 30 s idle timeout, 10 s connect timeout.
 * Idle-error listener attached so a dropped socket in the pool never
 * takes the process down.
 */
export function buildPool(config: DbConfig): pg.Pool {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 10,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
  })

  pool.on('error', (err) => {
    // Backstop: idle-client errors otherwise crash the process.
    // Fastify's request logger owns anything happening during a query.
    console.error('[db] idle client error (connection will be replaced):', err.message)
  })

  return pool
}
