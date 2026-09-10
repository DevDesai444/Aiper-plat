/**
 * WS integration tests for /ws — real WebSocket clients speak
 * y-protocols to the room registry over a bound loopback port.
 *
 * app.inject() does not exercise the upgrade path, so this file starts
 * the server on a random port and uses the `ws` client to connect.
 * SNAPSHOT_AUTO_INTERVAL_MS is dialled down to 200 ms so the auto-tick
 * fires inside the test's timeout window; production is 30 s.
 *
 * Coverage:
 *   1. Handshake — bad token → close 4001.
 *   2. Handshake — valid token, non-existent doc → close 4003
 *      (existence-leak guard — same code as no-grant-at-all).
 *   3. Two peers converge — an edit on client A shows up on client B
 *      via the room's sync-update fan-out.
 *   4. Auto-snapshot tick — a dirty room persists to document_snapshots
 *      with reason='auto' and no audit_log row (matches the wk-4
 *      interface freeze — auto-saves are durability, not intent).
 */

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { SignJWT } from 'jose'
import WebSocket from 'ws'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { setupTestDb, teardownTestDb, truncateAll, testDbConfig } from './helpers/testdb.js'

const SECRET = 'test-secret-plenty-long-enough-for-hs256'
const ISSUER = 'https://test-project.supabase.co/auth/v1'
const AUTO_INTERVAL_MS = 200
const MISSING_UUID = '99999999-9999-9999-9999-999999999999'

const MESSAGE_SYNC = 0

let db: pg.Pool
let app: FastifyInstance
let baseUrl: string

before(async () => {
  db = await setupTestDb()
  const t = testDbConfig()
  const config: Config = {
    PORT: 0,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    AIPER_ORG_NAME: 'Aiper',
    SUPABASE_JWT_TEST_SECRET: SECRET,
    SUPABASE_JWT_ISSUER: ISSUER,
    PGHOST: t.host,
    PGPORT: t.port,
    PGUSER: t.user,
    PGPASSWORD: t.password,
    PGDATABASE: t.database,
    SNAPSHOT_AUTO_INTERVAL_MS: AUTO_INTERVAL_MS,
  }
  app = await buildServer(config, db)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (!addr || typeof addr === 'string') throw new Error('listen returned no address')
  baseUrl = `ws://127.0.0.1:${addr.port}`
})
after(async () => {
  await app.close()
  await teardownTestDb(db)
})
beforeEach(async () => {
  await truncateAll(db)
})

// ------------------------------------------------------------ fixture helpers

async function signToken(sub: string, email: string, displayName: string): Promise<string> {
  return new SignJWT({ sub, email, user_metadata: { name: displayName } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

interface SeededUser {
  id: string
  displayName: string
  token: string
}

async function seedUser(email: string, displayName: string): Promise<SeededUser> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    [id, email, displayName],
  )
  const token = await signToken(id, email, displayName)
  return { id, displayName, token }
}

/** Alice owns one document via the creator-auto-owns trigger. */
async function seedAliceDoc(): Promise<{ alice: SeededUser; doc: string }> {
  const alice = await seedUser('alice@example.com', 'Alice')
  const orgId = randomUUID()
  await db.query(
    'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)',
    [orgId, 'Acme', 'acme'],
  )
  const projectId = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [projectId, orgId, 'MISSION-X', 'mission-x', alice.id],
  )
  const folderId = randomUUID()
  await db.query(
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, NULL, $3, $4)',
    [folderId, projectId, 'TCS', alice.id],
  )
  const doc = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, 'TVAC Report', 'authored', $3)`,
    [doc, folderId, alice.id],
  )
  return { alice, doc }
}

/**
 * A tiny y-websocket client that speaks the same protocol the server
 * does — just enough to drive a Y.Doc through the room and read back
 * fan-out messages. Not a general-purpose client; built for these
 * tests and nothing else.
 */
class TestClient {
  readonly doc = new Y.Doc()
  private ws: WebSocket
  private ready: Promise<void>

  constructor(baseUrl: string, token: string, docId: string) {
    const url = `${baseUrl}/ws?token=${encodeURIComponent(token)}&doc=${docId}`
    this.ws = new WebSocket(url)
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })

    // Broadcast local edits to the server as sync updates.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Skip updates we applied from the server — origin is the ws
      // instance in that path.
      if (origin === this.ws) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      writeUpdate(encoder, update)
      this.ws.send(encoding.toUint8Array(encoder))
    })

    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      const bytes = data instanceof Buffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer)
      const decoder = decoding.createDecoder(bytes)
      const type = decoding.readVarUint(decoder)
      if (type !== MESSAGE_SYNC) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      // Apply any sync payload; origin=ws tags it so the doc.on('update')
      // above does not echo it back to the server.
      readSyncMessage(decoder, encoder, this.doc, this.ws)
      if (encoding.length(encoder) > 1) {
        this.ws.send(encoding.toUint8Array(encoder))
      }
    })
  }

  async open(): Promise<void> {
    await this.ready
  }

  /** Kick off the initial exchange by asking the server for its state.
   *  Matches what real y-websocket clients do; the server also sends
   *  its own SyncStep1 on connect, so both sides pull each other's
   *  updates. */
  requestServerState(): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    writeSyncStep1(encoder, this.doc)
    this.ws.send(encoding.toUint8Array(encoder))
  }

  close(): void {
    this.ws.close()
  }

  get socket(): WebSocket {
    return this.ws
  }
}

/** Small delay helper — waits for the auto-snapshot timer to fire. */
async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ============================================================================
// Handshake
// ============================================================================

test('WS handshake rejects a bad token with close code 4001', async () => {
  const { doc } = await seedAliceDoc()
  const ws = new WebSocket(`${baseUrl}/ws?token=not-a-real-jwt&doc=${doc}`)
  const [code] = (await once(ws, 'close')) as [number, Buffer]
  assert.equal(code, 4001, 'bad_token close code')
})

test('WS handshake rejects a valid token but non-existent doc with close code 4003', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const ws = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(alice.token)}&doc=${MISSING_UUID}`)
  const [code] = (await once(ws, 'close')) as [number, Buffer]
  assert.equal(code, 4003, 'no_access close code — collapses non-existent + no-grant')
})

test('WS handshake rejects malformed query with close code 4400', async () => {
  const alice = await seedUser('alice@example.com', 'Alice')
  const ws = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(alice.token)}&doc=not-a-uuid`)
  const [code] = (await once(ws, 'close')) as [number, Buffer]
  assert.equal(code, 4400, 'bad_request close code')
})

// ============================================================================
// Fan-out
// ============================================================================

test('two peers converge — an edit on client A appears on client B', async () => {
  const { alice, doc } = await seedAliceDoc()

  const a = new TestClient(baseUrl, alice.token, doc)
  const b = new TestClient(baseUrl, alice.token, doc)
  try {
    await Promise.all([a.open(), b.open()])
    // Both clients ask the server for its state; the server also
    // sent them SyncStep1 on connect, so the doc converges after the
    // full 4-message exchange settles.
    a.requestServerState()
    b.requestServerState()

    // Peer A writes; peer B should observe the same text after the
    // room fans out the sync update.
    a.doc.getText('t').insert(0, 'hello world')

    // Poll for convergence — the fan-out is async through two socket
    // hops (A → server → B). 500 ms is generous for loopback.
    const start = Date.now()
    let seen = ''
    while (Date.now() - start < 500) {
      seen = b.doc.getText('t').toString()
      if (seen === 'hello world') break
      await wait(20)
    }
    assert.equal(seen, 'hello world', 'peer B saw the update from peer A')
  } finally {
    a.close()
    b.close()
  }
})

// ============================================================================
// Auto-snapshot persistence
// ============================================================================

test('auto-snapshot tick persists a dirty room to document_snapshots (reason=auto, no audit)', async () => {
  const { alice, doc } = await seedAliceDoc()

  const client = new TestClient(baseUrl, alice.token, doc)
  try {
    await client.open()
    client.requestServerState()
    client.doc.getText('t').insert(0, 'persistence check')

    // Wait for at least one auto-tick past the moment the update
    // reached the server. AUTO_INTERVAL_MS is 200; give it 3 ticks
    // worth of headroom on top for GH-runner-slow environments.
    await wait(AUTO_INTERVAL_MS * 3 + 200)

    const snaps = await db.query<{ reason: string; saved_by: string }>(
      `SELECT reason, saved_by FROM document_snapshots WHERE document_id = $1`,
      [doc],
    )
    assert.equal(snaps.rowCount, 1, 'exactly one auto-snapshot landed')
    assert.equal(snaps.rows[0]!.reason, 'auto')
    assert.equal(snaps.rows[0]!.saved_by, alice.id)

    // And the audit log stayed empty — auto is silent by contract.
    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log`,
    )
    assert.equal(audit.rows[0]!.n, '0', 'auto-snapshots do not audit')
  } finally {
    client.close()
  }
})

test('last-peer disconnect flushes a final auto-snapshot before dropping the room', async () => {
  const { alice, doc } = await seedAliceDoc()

  const client = new TestClient(baseUrl, alice.token, doc)
  await client.open()
  client.requestServerState()
  client.doc.getText('t').insert(0, 'last-peer flush')

  // Give the update a moment to propagate to the server, then close.
  // The server's onClose handler awaits persistIfDirty before dropping
  // the room, so a fresh SELECT should see the row.
  await wait(50)
  client.close()
  await wait(200)

  const snaps = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_snapshots WHERE document_id = $1`,
    [doc],
  )
  assert.ok(Number(snaps.rows[0]!.n) >= 1, 'a snapshot landed by the last-peer flush')
})
