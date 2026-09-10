import 'dotenv/config'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { buildPool, type DbConfig } from '../../src/db.js'
import { runMigrations } from '../../src/db/migrate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// apps/server/test/helpers/testdb.ts → up 4 to repo root, then into migrations/
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'migrations')

/** Read the connection details every test file needs. Defaults match the
 *  docker-compose.yml stub. TEST_PGDATABASE lets CI use a dedicated db. */
export function testDbConfig(): DbConfig & { adminDatabase: string } {
  return {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'aiper',
    password: process.env.PGPASSWORD ?? 'aiper_dev',
    database: process.env.TEST_PGDATABASE ?? 'aiper_test',
    adminDatabase: 'postgres',
  }
}

/** Names of every data table that migrations create. Truncated between
 *  tests so each case starts from a clean slate. schema_migrations
 *  intentionally stays populated — nobody re-runs migrations between
 *  cases, only between test files. */
const DATA_TABLES = [
  'access_grants',
  'documents',
  'folders',
  'projects',
  'org_members',
  'organizations',
  'users',
] as const

/**
 * Ensure the test database exists, connect to it, and run every migration
 * from migrations/. Idempotent — safe to call from multiple test files.
 */
export async function setupTestDb(): Promise<pg.Pool> {
  const cfg = testDbConfig()

  // Try to create the database if missing. Connect to `postgres` for the
  // CREATE DATABASE (you cannot CREATE DATABASE while connected to the
  // target). Ignored if the user lacks CREATEDB — presumably the DB was
  // pre-provisioned in that case and the next connect will succeed.
  const admin = new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.adminDatabase,
  })
  try {
    const check = await admin.query<{ exists: boolean }>(
      'SELECT true AS exists FROM pg_database WHERE datname = $1',
      [cfg.database],
    )
    if (check.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${cfg.database.replace(/"/g, '""')}"`)
    }
  } catch (err) {
    // Non-fatal — if the caller already created the db out-of-band, the
    // main connect below will succeed. If it fails there too, the caller
    // sees a clear connection error.
    console.warn(`[testdb] could not ensure database "${cfg.database}": ${(err as Error).message}`)
  } finally {
    await admin.end()
  }

  const pool = buildPool(cfg)
  await runMigrations(pool, MIGRATIONS_DIR)
  return pool
}

/** Wipe all data between test cases. Preserves the schema itself. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`)
}

/** Close the pool at the end of a test file. */
export async function teardownTestDb(pool: pg.Pool): Promise<void> {
  await pool.end()
}
