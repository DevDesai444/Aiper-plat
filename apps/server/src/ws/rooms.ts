import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type pg from 'pg'
import type { FastifyBaseLogger } from 'fastify'
import { saveSnapshot } from '../snapshots.js'

/**
 * Yjs room registry — one Y.Doc per active document_id, shared across
 * all peers currently connected to that room. The registry is the
 * bridge between the WebSocket layer (index.ts) and the storage layer
 * (saveSnapshot in ../snapshots.ts).
 *
 * Wire protocol matches y-protocols exactly (outer varuint 0 = SYNC,
 * 1 = AWARENESS). Server never sets a local awareness state; it just
 * relays deltas from peers.
 *
 * Persistence:
 *   - On first join for a document, hydrate the Y.Doc from the latest
 *     document_snapshots row (applyUpdate) and record the state
 *     vector so a stale open (no edits) never triggers a re-persist.
 *   - Every autoSnapshotIntervalMs, if the room is dirty (an editor
 *     peer landed a SyncStep2 or SyncUpdate since the last save),
 *     encode the doc state and call saveSnapshot(reason='auto'). The
 *     persist path also compares state vectors; if the vector has not
 *     moved since the last snapshot, the write is skipped — a defence
 *     against phantom snapshots from mis-set dirty flags.
 *   - On last-peer-disconnect, flush a final auto-snapshot before
 *     dropping the in-memory doc. All persist calls are serialised
 *     onto one promise chain: an edit that lands while a save is in
 *     flight sets dirty back to true and the chained loop iteration
 *     picks it up, so no edit is ever lost in the flush window.
 *
 * Redis fan-out for multi-instance deployments is a Phase-5 concern;
 * a single-instance server is fine for MVP.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const SYNC_STEP1 = 0
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/**
 * The socket surface the registry cares about. Real @fastify/websocket
 * connections implement this (they are `ws` WebSockets); tests plug in
 * an in-process fake. Keeping the surface small keeps unit tests
 * honest — the room's fan-out logic is exercised without the network.
 */
export interface PeerSocket {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
  /** Register a message handler. The registry calls this exactly once
   *  per peer, right after connect() decides to admit them. */
  onMessage(handler: (bytes: Uint8Array) => void): void
  /** Register a close handler. The registry uses it to remove the peer
   *  from the room and, if last, flush + tear down. */
  onClose(handler: () => void): void
}

export type PeerRole = 'viewer' | 'editor' | 'owner'

export interface Peer {
  userId: string
  printedName: string
  role: PeerRole
  socket: PeerSocket
}

interface Room {
  doc: Y.Doc
  awareness: Awareness
  peers: Set<Peer>
  /** Which Yjs awareness clientIDs each peer's state occupies. Populated
   *  from the awareness update stream keyed on `origin` and used to
   *  remove the peer's cursors on disconnect. Cannot be derived from
   *  the `Peer` object alone — the clientID is assigned by the client's
   *  own Yjs runtime and rides inside its first awareness frame. */
  peerClients: Map<Peer, Set<number>>
  /** True if any editor peer has landed a SyncStep2 or SyncUpdate since
   *  the last persist. SyncStep1 is a read (peer asking us for state)
   *  and does NOT dirty the room. */
  dirty: boolean
  /** The user whose update most recently made the room dirty. Their id
   *  goes into document_snapshots.saved_by for the next auto-save so
   *  the timeline attributes the persistence tick to a real person. */
  lastEditor: { id: string; printedName: string } | null
  autoTimer: NodeJS.Timeout | null
  /** State vector last written to document_snapshots (or captured on
   *  hydrate). If a persist would encode a state vector byte-equal to
   *  this, the write is skipped — an auto-tick with no real change
   *  should not create a phantom history row. */
  lastPersistedStateVector: Uint8Array | null
  /** Serialisation chain — every persist() awaits the prior one, so
   *  two callers (timer + last-peer flush) never race and no in-flight
   *  save silently drops a concurrent edit. */
  persistChain: Promise<void>
  hydrated: Promise<void>
}

export interface RoomRegistryOpts {
  autoSnapshotIntervalMs: number
  logger: FastifyBaseLogger
}

/** Byte-equality helper — Buffer.equals only works when both operands
 *  are Buffers, and lib0/Yjs hand back Uint8Arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

export class RoomRegistry {
  private rooms = new Map<string, Room>()
  private closed = false

  constructor(private pool: pg.Pool, private opts: RoomRegistryOpts) {}

  /**
   * Attach `peer` to the room for `documentId`, hydrating the room's
   * Y.Doc from the latest snapshot on first join. Kicks off the initial
   * y-protocols sync + awareness exchange and wires the peer's message
   * and close handlers.
   */
  async connect(documentId: string, peer: Peer): Promise<void> {
    if (this.closed) {
      peer.socket.close(1012, 'server shutting down')
      return
    }
    const room = await this.joinOrCreate(documentId, peer)
    this.attachPeer(documentId, room, peer)
  }

  /**
   * Persist every dirty room, close every peer socket, and clear the
   * map. Called from server shutdown; also handy for tests that want a
   * clean teardown between cases.
   */
  async shutdown(): Promise<void> {
    this.closed = true
    const flushes: Promise<void>[] = []
    for (const [docId, room] of this.rooms) {
      if (room.autoTimer) clearInterval(room.autoTimer)
      room.autoTimer = null
      for (const p of room.peers) {
        try {
          p.socket.close(1001, 'server shutting down')
        } catch {
          // socket may already be gone; the persist below still runs.
        }
      }
      flushes.push(this.persist(docId, room).catch((err) => {
        this.opts.logger.error({ err, docId }, 'ws: shutdown persist failed')
      }))
    }
    await Promise.all(flushes)
    // Awareness's outdated-check interval must be destroyed too,
    // otherwise it holds the event loop open past app.close().
    for (const room of this.rooms.values()) {
      room.awareness.destroy()
      room.doc.destroy()
    }
    this.rooms.clear()
  }

  private async joinOrCreate(documentId: string, peer: Peer): Promise<Room> {
    const existing = this.rooms.get(documentId)
    if (existing) {
      await existing.hydrated
      return existing
    }

    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState(null)

    const room: Room = {
      doc,
      awareness,
      peers: new Set(),
      peerClients: new Map(),
      dirty: false,
      lastEditor: null,
      autoTimer: null,
      lastPersistedStateVector: null,
      persistChain: Promise.resolve(),
      hydrated: Promise.resolve(),
    }
    this.rooms.set(documentId, room)

    room.hydrated = this.hydrate(documentId, room).catch((err) => {
      this.opts.logger.error({ err, docId: documentId }, 'ws: hydrate failed')
    })
    await room.hydrated

    // Fan out any update the doc receives to every peer except the
    // origin. `origin` is the Peer that sent us the update (or a
    // string like 'hydrate' for the seed apply). Peers-that-aren't-
    // peers are skipped by the identity comparison below.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      writeUpdate(encoder, update)
      const bytes = encoding.toUint8Array(encoder)
      for (const p of room.peers) {
        if (p === origin) continue
        try {
          p.socket.send(bytes)
        } catch (err) {
          this.opts.logger.debug({ err }, 'ws: send failed (peer probably closed)')
        }
      }
    })

    // Awareness deltas: relay to every peer except the sender AND
    // record which client IDs each peer owns so disconnect can remove
    // exactly the right cursors.
    awareness.on('update', (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      // Attribute IDs to a peer only when the origin is a peer we
      // currently admit. During removeAwarenessStates from a
      // disconnect the peer is already out of room.peers, so this
      // branch is (correctly) skipped for the departure path.
      if (origin && room.peers.has(origin as Peer)) {
        const peer = origin as Peer
        let set = room.peerClients.get(peer)
        if (!set) {
          set = new Set()
          room.peerClients.set(peer, set)
        }
        for (const id of added) set.add(id)
        for (const id of updated) set.add(id)
        for (const id of removed) set.delete(id)
      }

      const changed = added.concat(updated).concat(removed)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, changed))
      const bytes = encoding.toUint8Array(encoder)
      for (const p of room.peers) {
        if (p === origin) continue
        try {
          p.socket.send(bytes)
        } catch (err) {
          this.opts.logger.debug({ err }, 'ws: awareness send failed')
        }
      }
    })

    this.startAutoTimer(documentId, room)
    return room
  }

  /**
   * (Re)start the auto-snapshot interval for a room. Idempotent: if a
   * timer is already running, leave it. Called from joinOrCreate on
   * first join and from attachPeer on any subsequent join — the second
   * case matters because a peer arriving during a mid-flush teardown
   * (handlePeerLeave cleared the timer but is still awaiting persist)
   * finds a room with `autoTimer === null` that must be resurrected,
   * otherwise the room runs un-checkpointed until full teardown.
   */
  private startAutoTimer(documentId: string, room: Room): void {
    if (room.autoTimer) return
    if (this.closed) return
    room.autoTimer = setInterval(() => {
      void this.persist(documentId, room).catch((err) => {
        this.opts.logger.error({ err, docId: documentId }, 'ws: auto-tick persist failed')
      })
    }, this.opts.autoSnapshotIntervalMs)
  }

  private async hydrate(documentId: string, room: Room): Promise<void> {
    const row = await this.pool.query<{ yjs_state: Buffer }>(
      `SELECT yjs_state FROM document_snapshots
        WHERE document_id = $1
        ORDER BY saved_at DESC
        LIMIT 1`,
      [documentId],
    )
    if (row.rowCount === 0) {
      // Empty doc — capture the empty state vector so an open-only
      // session never triggers a dedupe miss and re-persist.
      room.lastPersistedStateVector = Y.encodeStateVector(room.doc)
      return
    }
    Y.applyUpdate(room.doc, row.rows[0]!.yjs_state, 'hydrate')
    room.lastPersistedStateVector = Y.encodeStateVector(room.doc)
  }

  private attachPeer(documentId: string, room: Room, peer: Peer): void {
    room.peers.add(peer)

    // If this peer arrived while a prior last-peer disconnect had
    // cleared the auto-timer but was still awaiting its persist, the
    // room survives (peers.size will be > 0 by the time the flush
    // checks) but the timer would stay dead. Resurrect it now.
    this.startAutoTimer(documentId, room)

    // Send our state vector so the peer can compute what it lacks.
    // Peer will reply with a SyncStep2 (update) and its own SyncStep1;
    // both are handled in handleMessage.
    const syncEncoder = encoding.createEncoder()
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC)
    writeSyncStep1(syncEncoder, room.doc)
    peer.socket.send(encoding.toUint8Array(syncEncoder))

    const awarenessStates = room.awareness.getStates()
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        awarenessEncoder,
        encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys())),
      )
      peer.socket.send(encoding.toUint8Array(awarenessEncoder))
    }

    peer.socket.onMessage((bytes) => {
      this.handleMessage(documentId, room, peer, bytes)
    })
    peer.socket.onClose(() => {
      void this.handlePeerLeave(documentId, room, peer)
    })
  }

  /**
   * Route one binary frame from a peer. Every failure mode — bad outer
   * type byte, bad sync sub-type, bad awareness payload, bad y-update
   * bytes — MUST drop the frame and leave the process running. lib0
   * throws on garbage and there is no other net for it; a crash here
   * kills every other room on the server.
   */
  private handleMessage(
    documentId: string,
    room: Room,
    peer: Peer,
    bytes: Uint8Array,
  ): void {
    let outerType: number
    try {
      const outerDecoder = decoding.createDecoder(bytes)
      outerType = decoding.readVarUint(outerDecoder)
    } catch (err) {
      this.opts.logger.debug({ err, docId: documentId }, 'ws: malformed frame header')
      return
    }

    switch (outerType) {
      case MESSAGE_SYNC:
        this.handleSync(documentId, room, peer, bytes)
        break
      case MESSAGE_AWARENESS:
        this.handleAwareness(documentId, room, peer, bytes)
        break
      default:
        this.opts.logger.debug(
          { messageType: outerType, docId: documentId },
          'ws: unknown outer message type',
        )
    }
  }

  private handleSync(documentId: string, room: Room, peer: Peer, bytes: Uint8Array): void {
    // Peek the sub-type once so we can gate viewer-write rejection AND
    // dirty-eligibility BEFORE any y-protocols call that could throw
    // on malformed bytes. SyncStep1 is a pure read (peer asks for our
    // state), so it never marks the room dirty; a viewer is entitled
    // to send it. SyncStep2 / SyncUpdate carry writes and are blocked
    // for viewers.
    let subType: number
    try {
      const peek = decoding.createDecoder(bytes)
      decoding.readVarUint(peek) // outer type, already read
      subType = decoding.readVarUint(peek)
    } catch (err) {
      this.opts.logger.debug({ err, docId: documentId }, 'ws: malformed sync sub-type')
      return
    }

    const isDocWrite = subType === SYNC_STEP2 || subType === SYNC_UPDATE
    if (peer.role === 'viewer' && isDocWrite) {
      this.opts.logger.warn(
        { docId: documentId, userId: peer.userId },
        'ws: viewer attempted a doc write; ignoring',
      )
      return
    }

    try {
      const decoder = decoding.createDecoder(bytes)
      decoding.readVarUint(decoder) // consume outer type
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      readSyncMessage(decoder, encoder, room.doc, peer)
      if (encoding.length(encoder) > 1) {
        peer.socket.send(encoding.toUint8Array(encoder))
      }
    } catch (err) {
      // readSyncMessage / applyUpdate can throw on malformed y-update
      // bytes. Drop the frame; the state stays coherent because the
      // partial applyUpdate would have thrown before mutating (Yjs
      // handles this via a transaction).
      this.opts.logger.debug({ err, docId: documentId, subType }, 'ws: sync decode failed; dropping frame')
      return
    }

    // Only writes dirty the room. SyncStep1 stays clean so opening a
    // doc without editing does not create a phantom snapshot.
    if (isDocWrite && peer.role !== 'viewer') {
      room.dirty = true
      room.lastEditor = { id: peer.userId, printedName: peer.printedName }
    }
  }

  private handleAwareness(documentId: string, room: Room, peer: Peer, bytes: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(bytes)
      decoding.readVarUint(decoder) // consume outer type
      applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), peer)
    } catch (err) {
      this.opts.logger.debug({ err, docId: documentId }, 'ws: awareness apply failed; dropping frame')
    }
  }

  private async handlePeerLeave(documentId: string, room: Room, peer: Peer): Promise<void> {
    room.peers.delete(peer)

    // Withdraw exactly this peer's awareness clients so remaining
    // peers see their cursors vanish immediately, rather than waiting
    // out the beforeunload handshake (which browsers do not
    // guarantee) or the awareness protocol's own timeout (~30 s).
    const clients = room.peerClients.get(peer)
    room.peerClients.delete(peer)
    if (clients && clients.size > 0) {
      removeAwarenessStates(room.awareness, Array.from(clients), peer)
    }

    if (room.peers.size > 0) return

    // Last peer gone. Kill the timer, drain any in-flight persist +
    // any dirty edits it missed, then tear down — unless a fresh
    // peer joined during the flush, in which case leave the room.
    if (room.autoTimer) clearInterval(room.autoTimer)
    room.autoTimer = null

    try {
      await this.persist(documentId, room)
    } catch (err) {
      this.opts.logger.error({ err, docId: documentId }, 'ws: last-peer flush failed')
    }

    if (room.peers.size === 0) {
      // y-protocols/awareness registers its own outdated-check
      // setInterval on construction. Must be destroyed alongside the
      // Y.Doc or it will keep the Node event loop alive forever.
      room.awareness.destroy()
      room.doc.destroy()
      this.rooms.delete(documentId)
    }
  }

  /**
   * Serialised, dedupe-aware persist. Chained onto the room's prior
   * persist so two concurrent triggers (timer + last-peer flush) do
   * not race, and looped internally so an edit that lands during a
   * save is not silently dropped:
   *
   *   1. Wait for any prior persist on this room.
   *   2. If dirty and lastEditor set, encode state + state vector.
   *   3. Reset dirty = false BEFORE writing so edits landing during
   *      the await set it back to true and trigger another loop.
   *   4. If the state vector byte-matches lastPersistedStateVector,
   *      skip the write — the doc has not moved since the last save.
   *   5. Otherwise write via saveSnapshot(reason='auto', label=null)
   *      and update lastPersistedStateVector.
   *   6. Loop until dirty is stable-false.
   */
  private async persist(documentId: string, room: Room): Promise<void> {
    const prior = room.persistChain
    const my = prior.then(() => this.doPersist(documentId, room))
    // Keep the chain alive even if this iteration throws — the next
    // caller should still get to run.
    room.persistChain = my.catch(() => {})
    return my
  }

  private async doPersist(documentId: string, room: Room): Promise<void> {
    while (room.dirty && room.lastEditor) {
      const editor = room.lastEditor
      const state = Y.encodeStateAsUpdate(room.doc)
      const sv = Y.encodeStateVector(room.doc)
      // Acquire dirty=false before the await so any edit landing
      // during the DB write sets it back to true and forces another
      // iteration.
      room.dirty = false

      if (room.lastPersistedStateVector && bytesEqual(sv, room.lastPersistedStateVector)) {
        // No actual state change — nothing to persist. Loop guard
        // will exit if dirty stays false.
        continue
      }

      const buf = Buffer.from(state.buffer, state.byteOffset, state.byteLength)
      await saveSnapshot(this.pool, documentId, buf, {
        reason: 'auto',
        label: null,
        userReason: null,
        actor: { id: editor.id, printedName: editor.printedName },
      })
      // Copy the SV — Yjs may reuse the underlying buffer for future
      // encodings, and we're going to hold this reference until the
      // next comparison.
      room.lastPersistedStateVector = new Uint8Array(sv)
    }
  }

  /** Test-only accessor: how many rooms are live? */
  public roomCount(): number {
    return this.rooms.size
  }

  /** Test-only accessor: is the given document's room dirty? */
  public isDirty(documentId: string): boolean {
    return this.rooms.get(documentId)?.dirty ?? false
  }

  /** Test-only accessor: how many awareness clients does the room see
   *  right now? Used by the ghost-cursor test to confirm the departed
   *  peer's cursor was removed. */
  public awarenessClientCount(documentId: string): number {
    return this.rooms.get(documentId)?.awareness.getStates().size ?? 0
  }

  /** Test-only accessor: is the auto-snapshot timer running for this
   *  room? Used by the rejoin-mid-flush test to prove the timer is
   *  restarted (not silently left dead) when a peer joins a room
   *  whose prior last-peer flush had cleared it. */
  public hasAutoTimer(documentId: string): boolean {
    return this.rooms.get(documentId)?.autoTimer != null
  }
}
