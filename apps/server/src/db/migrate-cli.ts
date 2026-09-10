import 'dotenv/config'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPool } from '../db.js'
import { runMigrations } from './migrate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// apps/server/src/db/migrate-cli.ts → up 4 to repo root, then into migrations/
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'migrations')

async function main(): Promise<void> {
  const host = process.env.PGHOST
  const user = process.env.PGUSER
  const password = process.env.PGPASSWORD
  const database = process.env.PGDATABASE
  if (!host || !user || !password || !database) {
    console.error(
      'Missing DB env: PGHOST, PGUSER, PGPASSWORD, PGDATABASE are all required.\n' +
        'See apps/server/.env.example.',
    )
    process.exit(1)
  }
  const pool = buildPool({
    host,
    port: Number(process.env.PGPORT ?? 5432),
    user,
    password,
    database,
  })
  try {
    const { applied, skipped } = await runMigrations(pool, MIGRATIONS_DIR)
    for (const f of skipped) console.log(`skip  ${f}`)
    for (const f of applied) console.log(`apply ${f}`)
    console.log(`Done. ${applied.length} applied, ${skipped.length} already up to date.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
