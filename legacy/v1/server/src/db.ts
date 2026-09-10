import pg from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LAKEBASE_HOST =
  process.env.AIPER_DB_HOST ?? 'ep-hidden-waterfall-d25k3neu.database.us-east-1.cloud.databricks.com'
const LAKEBASE_USER = process.env.AIPER_DB_USER ?? 'dev.desai@aiper.com'
const LAKEBASE_DB = process.env.AIPER_DB_NAME ?? 'databricks_postgres'

/**
 * Lakebase authenticates Postgres connections with a Databricks OAuth token used as the
 * password, and those tokens expire after an hour. `pg` accepts a function for `password`
 * and calls it per connection, so refreshing here keeps a long-running server alive without
 * any reconnect logic elsewhere.
 */
let cached: { token: string; expiresAt: number } | null = null
/**
 * The fetch currently in flight, if any.
 *
 * Without this, a cold pool is a thundering herd: `pg` opens one connection per waiting query,
 * each calls this function, none of them sees a cached token yet, and every one of them spawns
 * its own `databricks auth token`. Those processes contend on the CLI's shared token cache, so
 * some fail — which surfaced as the app loading with "Internal Server Error" in the project
 * tree roughly every other time, because it asks for folders and documents at the same moment.
 *
 * One fetch, shared by everyone waiting on it.
 */
let inFlight: Promise<string> | null = null

async function databricksToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { stdout } = await execFileAsync('databricks', ['auth', 'token'], { maxBuffer: 1024 * 1024 })
      const parsed = JSON.parse(stdout) as { access_token: string; expires_in?: number }
      // One line per real fetch. Should appear once at startup and about hourly after that;
      // a burst of them means the single-flight guard above has stopped working.
      console.log('[db] fetched a fresh Databricks token')
      cached = {
        token: parsed.access_token,
        expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000
      }
      return cached.token
    } finally {
      // Cleared on failure too, so a transient CLI error does not wedge every later connection.
      inFlight = null
    }
  })()

  return inFlight
}

export const pool = new pg.Pool({
  host: LAKEBASE_HOST,
  port: 5432,
  user: LAKEBASE_USER,
  database: LAKEBASE_DB,
  ssl: { rejectUnauthorized: false },
  password: databricksToken,
  max: 8,
  // Lakebase is across the network, so idle sockets get reaped. Recycle them before that
  // happens and keep the survivors warm.
  idleTimeoutMillis: 10_000,
  keepAlive: true,
  connectionTimeoutMillis: 10_000
})

/**
 * A dropped idle connection makes `pg` emit 'error' on the pool. With no listener attached
 * that is an unhandled 'error' event, which terminates the process — a brief network blip to
 * Lakebase was enough to kill the whole server. Log it and let the pool replace the client.
 */
pool.on('error', (err) => {
  console.error('[db] idle client error (connection will be replaced):', err.message)
})

// Same reasoning one level up: a rejected query somewhere should not be able to take the
// server down with it. Fastify already replies 500 per-request; this is the backstop.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason)
})

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(text, params)
  return result.rows
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
