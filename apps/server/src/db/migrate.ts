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

  const alreadyAppliedRows = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  )
  const alreadyApplied = new Map(alreadyAppliedRows.rows.map((r) => [r.version, r.checksum]))

  // Drift detection: recompute sha256 of every already-applied migration
  // file on disk and compare to the recorded checksum. If any drifted,
  // refuse to boot. Rationale: someone edits an applied migration file
  // in place, the runner would otherwise silently skip it (already
  // recorded) and prod would forever diverge from dev. Fail loud, fail
  // named.
  for (const file of files) {
    const storedChecksum = alreadyApplied.get(file)
    if (storedChecksum === undefined) continue // not applied yet — the loop below applies it
    const disk = await readFile(join(migrationsDir, file), 'utf8')
    const diskChecksum = createHash('sha256').update(disk).digest('hex')
    if (diskChecksum !== storedChecksum) {
      throw new Error(
        `Migration ${file} was modified after being applied.\n` +
          `  Stored checksum: ${storedChecksum}\n` +
          `  On-disk sha256:  ${diskChecksum}\n` +
          `Migrations are immutable once applied. Revert the edits to ${file}, ` +
          `or write a NEW migration that changes the schema forward.`,
      )
    }
  }

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
