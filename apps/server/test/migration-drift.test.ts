import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { buildPool } from '../src/db.js'
import { runMigrations } from '../src/db/migrate.js'
import { testDbConfig } from './helpers/testdb.js'

const DB_NAME = 'aiper_migration_drift_test'

let pool: pg.Pool
let migrationsDir: string

async function withAdmin<T>(fn: (admin: pg.Pool) => Promise<T>): Promise<T> {
  const t = testDbConfig()
  const admin = new pg.Pool({
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: 'postgres',
  })
  try {
    return await fn(admin)
  } finally {
    await admin.end()
  }
}

before(async () => {
  // Fresh isolated DB so drift-mode edits do not touch aiper_test's
  // schema_migrations. Reset every run.
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`)
    await admin.query(`CREATE DATABASE "${DB_NAME}"`)
  })
  const t = testDbConfig()
  pool = buildPool({ ...t, database: DB_NAME })
  migrationsDir = await mkdtemp(join(tmpdir(), 'aiper-drift-'))
})

after(async () => {
  await pool.end().catch(() => {})
  await rm(migrationsDir, { recursive: true, force: true })
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`)
  })
})

test('a fresh migration applies cleanly and records its sha256', async () => {
  await writeFile(join(migrationsDir, '001_drift_mark.sql'), 'CREATE TABLE _drift_mark (id int PRIMARY KEY)')
  const { applied, skipped } = await runMigrations(pool, migrationsDir)
  assert.deepEqual(applied, ['001_drift_mark.sql'])
  assert.deepEqual(skipped, [])

  const rec = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  )
  assert.equal(rec.rowCount, 1)
  assert.equal(rec.rows[0]?.version, '001_drift_mark.sql')
  assert.match(rec.rows[0]!.checksum, /^[0-9a-f]{64}$/)
})

test('drift detection catches edits to an already-applied migration', async () => {
  // Alter the file's content after it was applied above. The runner
  // must refuse and name the file.
  await writeFile(
    join(migrationsDir, '001_drift_mark.sql'),
    'CREATE TABLE _drift_mark_tampered (id int PRIMARY KEY)',
  )
  await assert.rejects(
    () => runMigrations(pool, migrationsDir),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /001_drift_mark\.sql/)
      assert.match(err.message, /modified after being applied/i)
      return true
    },
  )
})

test('drift detection is idempotent — re-running after a good state still passes', async () => {
  // Restore the file to its original content — checksum matches again.
  await writeFile(
    join(migrationsDir, '001_drift_mark.sql'),
    'CREATE TABLE _drift_mark (id int PRIMARY KEY)',
  )
  const { applied, skipped } = await runMigrations(pool, migrationsDir)
  assert.deepEqual(applied, [])
  assert.deepEqual(skipped, ['001_drift_mark.sql'])
})
