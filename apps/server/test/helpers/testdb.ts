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
 *  cases, only between test files.
 *
 *  audit_log is included but its append-only + no-truncate triggers are
 *  disabled around the TRUNCATE call. In production these guarantee the
 *  chain is immutable; in tests we need a clean slate every case. */
const DATA_TABLES = [
  'audit_log',
  'access_grants',
  'document_snapshots',
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

/** Wipe all data between test cases. Preserves the schema itself.
 *  Disables audit_log's append-only + no-truncate triggers for the
 *  duration of the TRUNCATE; production code paths never do this. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate')
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only')
    await client.query(`TRUNCATE TABLE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`)
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate')
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only')
  } finally {
    client.release()
  }
}

/** Close the pool at the end of a test file. */
export async function teardownTestDb(pool: pg.Pool): Promise<void> {
  await pool.end()
}
