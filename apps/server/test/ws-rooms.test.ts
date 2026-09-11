/**
 * Room-registry unit tests — exercise the broadcaster without any
 * WebSocket transport by plugging mock PeerSockets straight into
 * RoomRegistry.connect(). Complements ws-integration.test.ts (which
 * covers the same paths over real `ws`).
 *
 * The registry still writes to Postgres on hydrate + persistIfDirty,
 * so we use setupTestDb() to give it a real pool. What we DO NOT need
 * is a Fastify server, jose, or a WS listener.
 */

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type pg from 'pg'
import type { FastifyBaseLogger } from 'fastify'
import { RoomRegistry, type Peer, type PeerSocket } from '../src/ws/rooms.js'
import { setupTestDb, teardownTestDb, truncateAll } from './helpers/testdb.js'

const MESSAGE_SYNC = 0

/** Silent logger — the registry logs some debug/warn lines around
 *  socket send failures we deliberately don't exercise here. */
const silentLogger: FastifyBaseLogger = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
  silent: () => {},
}

let db: pg.Pool
let registry: RoomRegistry

before(async () => {
  db = await setupTestDb()
})
after(async () => {
  await registry.shutdown()
  await teardownTestDb(db)
})
beforeEach(async () => {
  await truncateAll(db)
  // Fresh registry per test so leftover rooms from a prior case never
  // leak. Auto-tick set high enough that only explicit calls trigger
  // persistence — the tests here don't wait on the timer.
  await registry?.shutdown()
  registry = new RoomRegistry(db, {
    autoSnapshotIntervalMs: 10_000,
    logger: silentLogger,
  })
})

// ------------------------------------------------------------ fixture helpers

async function seedUser(displayName: string): Promise<{ id: string; displayName: string }> {
  const id = randomUUID()
  await db.query(
    'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    [id, `${id}@example.com`, displayName],
  )
  return { id, displayName }
}

async function seedDoc(createdBy: string): Promise<string> {
  const orgId = randomUUID()
  await db.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    orgId,
    'Acme',
    `acme-${orgId.slice(0, 8)}`,
  ])
  const projectId = randomUUID()
  await db.query(
    'INSERT INTO projects (id, org_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)',
    [projectId, orgId, 'MISSION-X', `mission-${projectId.slice(0, 8)}`, createdBy],
  )
  const folderId = randomUUID()
  await db.query(
    'INSERT INTO folders (id, project_id, parent_folder_id, name, created_by) VALUES ($1, $2, NULL, $3, $4)',
    [folderId, projectId, 'TCS', createdBy],
  )
  const docId = randomUUID()
  await db.query(
    `INSERT INTO documents (id, folder_id, title, kind, created_by)
       VALUES ($1, $2, 'TVAC Report', 'authored', $3)`,
    [docId, folderId, createdBy],
  )
  return docId
}

/**
 * A PeerSocket backed by two arrays and a pair of handler slots. Each
 * MockSocket sits at the "server end" of a virtual WS: the registry
 * writes into `sent`, and the test drives incoming messages via
 * `deliver()`.
 */
class MockSocket implements PeerSocket {
  readonly sent: Uint8Array[] = []
  closed: { code: number; reason: string } | null = null
  private messageHandler: ((bytes: Uint8Array) => void) | null = null
  private closeHandler: (() => void) | null = null

  send(bytes: Uint8Array): void {
    this.sent.push(bytes)
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.closeHandler?.()
  }
  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.messageHandler = handler
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
  /** Deliver bytes to the registry AS IF a client had sent them. */
  deliver(bytes: Uint8Array): void {
    if (!this.messageHandler) throw new Error('deliver() called before registry attached')
    this.messageHandler(bytes)
  }
  /** Fire the close handler as if the socket had dropped. */
  simulateDisconnect(): void {
    this.closeHandler?.()
  }
}

interface Sim {
  doc: Y.Doc
  socket: MockSocket
  peer: Peer
  bind: () => void
  /** Ask the registry for its current state — the server responds with
   *  a SyncStep2 the client applies via drainInto. Real y-websocket
   *  clients do this on connect; the mock has to be told to. */
  requestSync: () => void
}

/** Wrap a Y.Doc as a "client" and hook the same y-protocols messages a
 *  real client would send over the wire. */
function makeSim(userId: string, printedName: string, role: 'viewer' | 'editor' | 'owner'): Sim {
  const doc = new Y.Doc()
  const socket = new MockSocket()
  const peer: Peer = { userId, printedName, role, socket }

  const bind = () => {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'inbound') return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      writeUpdate(encoder, update)
      socket.deliver(encoding.toUint8Array(encoder))
    })
  }

  const requestSync = () => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    writeSyncStep1(encoder, doc)
    socket.deliver(encoding.toUint8Array(encoder))
  }

  return { doc, socket, peer, bind, requestSync }
}

/** Craft a MESSAGE_SYNC + SyncUpdate frame from an arbitrary update
 *  buffer — used to simulate a misbehaving viewer client that tries to
 *  push a write it never applied locally. */
function frameUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

/** Drain the sim's `sent` queue and apply anything the registry pushed
 *  onto the sim's Y.Doc. */
function drainInto(sim: Sim): void {
  while (sim.socket.sent.length > 0) {
    const bytes = sim.socket.sent.shift()!
    const decoder = decoding.createDecoder(bytes)
    const type = decoding.readVarUint(decoder)
    if (type !== MESSAGE_SYNC) continue
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    readSyncMessage(decoder, encoder, sim.doc, 'inbound')
    if (encoding.length(encoder) > 1) {
      sim.socket.deliver(encoding.toUint8Array(encoder))
    }
  }
}

// ------------------------------------------------------------------- tests

test('room broadcaster: an editor update on peer A reaches peer B', async () => {
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const a = makeSim(alex.id, alex.displayName, 'editor')
  const b = makeSim(alex.id, alex.displayName, 'editor')

  await registry.connect(docId, a.peer)
  await registry.connect(docId, b.peer)

  // Bind AFTER connect so the initial SyncStep1 the registry sent to
  // each sim is captured in `sent` — drainInto below applies it.
  a.bind()
  b.bind()

  // Handshake: apply what the registry sent (SyncStep1 → each side
  // replies with SyncStep2, which lands in the OTHER end via bind()).
  drainInto(a)
  drainInto(b)
  // Anything either side generated in response might have caused
  // further deliveries; drain once more to settle.
  drainInto(a)
  drainInto(b)

  // Peer A writes; peer B should observe it via fan-out.
  a.doc.getText('t').insert(0, 'hello broadcaster')
  drainInto(b)

  assert.equal(b.doc.getText('t').toString(), 'hello broadcaster')
})

test('room broadcaster: a viewer update is silently dropped, other peers unaffected', async () => {
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const viewer = makeSim('11111111-1111-1111-1111-111111111111', 'Viewer', 'viewer')
  const editor = makeSim(alex.id, alex.displayName, 'editor')

  await registry.connect(docId, viewer.peer)
  await registry.connect(docId, editor.peer)
  viewer.bind()
  editor.bind()

  // Simulate a misbehaving client that crafts a SyncUpdate frame
  // without ever applying the change locally. Building the payload
  // from a scratch Y.Doc avoids polluting `viewer.doc` — which would
  // muddy the "editor.doc unaffected" assertion below with local-only
  // CRDT state.
  const scratch = new Y.Doc()
  scratch.getText('t').insert(0, 'viewer-hack')
  const forgedUpdate = Y.encodeStateAsUpdate(scratch)
  viewer.socket.deliver(frameUpdate(forgedUpdate))

  assert.equal(editor.doc.getText('t').toString(), '', 'editor did not receive the viewer write')
  assert.equal(registry.isDirty(docId), false, 'viewer write did not dirty the room')

  // An editor write, by contrast, propagates and dirties the room.
  editor.doc.getText('t').insert(0, 'legit')
  drainInto(viewer)
  assert.equal(viewer.doc.getText('t').toString(), 'legit')
  assert.equal(registry.isDirty(docId), true, 'editor write dirtied the room')
})

test('room broadcaster: last-peer disconnect drops the room from the registry', async () => {
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const a = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, a.peer)

  assert.equal(registry.roomCount(), 1)
  a.socket.simulateDisconnect()
  // handlePeerLeave is async and awaits persistIfDirty. Yield the
  // event loop until the room count settles or a small timeout expires.
  const start = Date.now()
  while (registry.roomCount() !== 0 && Date.now() - start < 200) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(registry.roomCount(), 0, 'last-peer disconnect tears the room down')
})

test('room broadcaster: hydrate seeds the Y.Doc from the latest snapshot', async () => {
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  // Pre-seed a snapshot: build a Y.Doc off to the side, encode its
  // state, insert directly. The registry's hydrate() should pick it
  // up on first join.
  const seed = new Y.Doc()
  seed.getText('t').insert(0, 'pre-existing content')
  const state = Y.encodeStateAsUpdate(seed)
  await db.query(
    `INSERT INTO document_snapshots
       (document_id, yjs_state, reason, label, saved_by)
     VALUES ($1, $2, 'checkpoint', 'seed', $3)`,
    [docId, Buffer.from(state), alex.id],
  )

  const client = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, client.peer)
  client.bind()
  // The registry hydrated the room's Y.Doc but the client's Y.Doc
  // starts empty. Ask the server for its state; the SyncStep2 it
  // returns carries the hydrated content.
  client.requestSync()
  drainInto(client)

  assert.equal(client.doc.getText('t').toString(), 'pre-existing content')
})

// ============================================================================
// Hardening (PR-6): crash guard on malformed frames, dirty-only-on-writes,
// per-peer awareness cleanup on disconnect.
// ============================================================================

test('room broadcaster: a malformed frame is dropped, the room and process stay up', async () => {
  // lib0/decoding throws on garbage varuint bytes. Without a per-branch
  // try/catch these throws propagate out of the socket's 'message'
  // handler and take the process down. The registry must swallow the
  // frame and stay open for legitimate traffic on the same room.
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const client = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, client.peer)
  client.bind()

  // Garbage: never even parses as a valid outer-type varuint frame.
  // Also try one that reads a bogus outer type (255) and one that
  // reads type 0 (SYNC) but with unfinished body.
  const garbage = [
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]),
    new Uint8Array([0x00]),          // MESSAGE_SYNC only, no sub-type
    new Uint8Array([0x00, 0x7f]),    // SYNC + unknown sub-type + truncated
    new Uint8Array([0x01, 0xff]),    // AWARENESS but bad update length
  ]
  for (const bytes of garbage) {
    // Must not throw. If it does, the process would be down and this
    // test would report a crash rather than an assertion failure.
    client.socket.deliver(bytes)
  }

  // Room still alive, still accepting real frames.
  assert.equal(registry.roomCount(), 1)
  client.requestSync()
  drainInto(client)
  client.doc.getText('t').insert(0, 'still working')
  drainInto(client)
  assert.equal(client.doc.getText('t').toString(), 'still working')
})

test('room broadcaster: SyncStep1 (a read) does NOT dirty the room and does NOT persist', async () => {
  // Opening a doc — client sends SyncStep1 to ask for state — must
  // not trigger an auto-save. The prior implementation flipped dirty
  // on any SYNC frame from an editor, so a "silent open" was ending
  // up as a history row every 30 s. Explicit writes (SyncStep2 /
  // SyncUpdate) are the only things that dirty the room.
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const client = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, client.peer)
  client.bind()

  // Only send SyncStep1 — no writes at all.
  client.requestSync()

  assert.equal(registry.isDirty(docId), false, 'SyncStep1 must not dirty the room')

  // Even if we manually invoke persist (as the timer would), no row
  // lands — the doPersist loop exits because dirty is false. Sanity
  // check via the DB.
  const before = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_snapshots WHERE document_id = $1`,
    [docId],
  )
  assert.equal(before.rows[0]!.n, '0', 'no snapshot from a read-only open')
})

test('room broadcaster: a peer rejoining mid-flush keeps the auto-timer alive', async () => {
  // Race the sr-eng reviewer flagged: handlePeerLeave clears autoTimer
  // and nulls it BEFORE awaiting persist. If a peer joins during that
  // await, joinOrCreate returns the still-in-map room and the room
  // survives peer-count-wise, but the timer stayed dead — no
  // auto-checkpoints until full teardown.
  //
  // Fix: attachPeer calls startAutoTimer, which restarts a null timer
  // for a live room. This test forces the race: sim1 dirties then
  // disconnects, which starts handlePeerLeave's async persist (real
  // DB round-trip via saveSnapshot); sim2's connect completes during
  // that await; the room must still have a live autoTimer.

  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const sim1 = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, sim1.peer)
  sim1.bind()

  // Dirty the room so handlePeerLeave's flush has real work to do
  // (state vector will differ → saveSnapshot runs → real DB round-trip
  // during which the rejoin lands).
  sim1.doc.getText('t').insert(0, 'dirty before leave')
  drainInto(sim1)
  assert.equal(registry.isDirty(docId), true, 'sim1 edit dirtied the room')

  // Fire the disconnect. Synchronous portion of handlePeerLeave clears
  // the timer + sets autoTimer = null, then suspends on await persist.
  sim1.socket.simulateDisconnect()

  // Rejoin sim2 while handlePeerLeave's persist is still in flight.
  // joinOrCreate finds the room still in the map; attachPeer must
  // restart the timer.
  const sim2 = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, sim2.peer)

  assert.equal(registry.roomCount(), 1, 'room survived the mid-flush rejoin')
  assert.equal(registry.hasAutoTimer(docId), true, 'timer restarted on rejoin')

  // Let handlePeerLeave's persist + teardown check drain. peers.size
  // is 1 (sim2) by then, so the destroy branch is skipped.
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(registry.roomCount(), 1, 'room stayed after handlePeerLeave settled')
  assert.equal(
    registry.hasAutoTimer(docId),
    true,
    'timer still alive after handlePeerLeave settled — the bug would leave it null',
  )
})

test('room broadcaster: awareness state is gone after the peer disconnects', async () => {
  // Ghost cursors bug: on disconnect the old implementation filtered
  // by a clientID that never existed on Peer, so removeAwarenessStates
  // was a no-op and departed cursors lingered until the awareness
  // protocol's own timeout (~30 s). The fix tracks each peer's Yjs
  // clientIDs from the awareness stream and removes exactly those.
  const alex = await seedUser('Alex')
  const docId = await seedDoc(alex.id)

  const client = makeSim(alex.id, alex.displayName, 'editor')
  await registry.connect(docId, client.peer)
  client.bind()

  // Craft one awareness frame from the client — sets its cursor state.
  // The room tracks the client's Yjs clientID via the awareness update
  // origin correlation. Awareness registers its own setInterval on
  // construction; destroy() clears it so the test process can exit.
  const clientAwareness = new Awareness(client.doc)
  try {
    clientAwareness.setLocalState({ user: { name: 'Alex' } })
    const awarenessBytes = encodeAwarenessUpdate(clientAwareness, [client.doc.clientID])
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1 /* MESSAGE_AWARENESS */)
    encoding.writeVarUint8Array(encoder, awarenessBytes)
    client.socket.deliver(encoding.toUint8Array(encoder))
  } finally {
    clientAwareness.destroy()
  }

  assert.equal(
    registry.awarenessClientCount(docId),
    1,
    'awareness picked up the client after the update',
  )

  // Disconnect. The registry must remove exactly this client's awareness
  // state, not wait for the 30 s protocol timeout.
  client.socket.simulateDisconnect()
  // handlePeerLeave awaits persistIfDirty; give the microtask queue a
  // beat to settle before asserting.
  await new Promise((r) => setTimeout(r, 20))

  // Room may have been torn down (last peer). If it was, the client
  // count for that docId is 0 by construction. If it survives (a
  // fresh peer joined during the flush, which does not happen here),
  // the count should still be 0 after cleanup.
  assert.equal(registry.awarenessClientCount(docId), 0, 'no ghost cursor lingers')
})
