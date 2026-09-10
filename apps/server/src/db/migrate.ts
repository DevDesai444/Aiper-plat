import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type pg from 'pg'

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

/**
 * Run every migration under `migrationsDir` (filenames matching
 * `NNN_*.sql`) in numeric order that hasn't already been recorded in
 * schema_migrations. Each migration runs inside its own transaction so
 * a failure rolls back the SQL and leaves schema_migrations unchanged.
 *
 * Records a sha256 of each applied file — future work could refuse to
 * boot if the on-disk file drifts from what was originally recorded.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d{3,}_.+\.sql$/.test(f))
    .sort()

  const alreadyApplied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
      (r) => r.version,
    ),
  )

  const applied: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file)
      continue
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [file, checksum],
      )
      await client.query('COMMIT')
      applied.push(file)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err })
    } finally {
      client.release()
    }
  }

  return { applied, skipped }
}
