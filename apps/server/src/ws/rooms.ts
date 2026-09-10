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
 * Wire protocol matches y-protocols exactly (types are numbered
 * varuints — 0 = SYNC, 1 = AWARENESS). Server never sets a local
 * awareness state; it just relays deltas from peers.
 *
 * Persistence:
 *   - On first join for a document, hydrate the Y.Doc from the latest
 *     document_snapshots row (applyUpdate).
 *   - Every autoSnapshotIntervalMs, if the room is "dirty" (an editor
 *     peer landed an update since the last snapshot), encode the doc
 *     state and call saveSnapshot(reason='auto'). Auto-snapshots skip
 *     the audit_log write per the wk-4 interface freeze.
 *   - On last-peer-disconnect, flush a final auto-snapshot before
 *     dropping the in-memory doc. If a fresh peer connects while the
 *     flush is in flight, the room stays and the flush still completes
 *     harmlessly — the "delete the room" step only runs when the peer
 *     set is empty AFTER the save resolves.
 *
 * Redis fan-out for multi-instance deployments is a Phase-5 concern;
 * a single-instance server is fine for MVP.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

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
  /** True if any editor peer has landed an update since the last save.
   *  Viewer connects/disconnects don't touch this. */
  dirty: boolean
  /** The user whose update most recently made the room dirty. Their id
   *  goes into document_snapshots.saved_by for the next auto-save so
   *  the timeline attributes the persistence tick to a real person. */
  lastEditor: { id: string; printedName: string } | null
  autoTimer: NodeJS.Timeout | null
  /** True while hydration or a persistence flush is in flight. Prevents
   *  concurrent persist runs racing each other for the same doc. */
  persistInFlight: boolean
  hydrated: Promise<void>
}

export interface RoomRegistryOpts {
  autoSnapshotIntervalMs: number
  logger: FastifyBaseLogger
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
      // Close every peer with 1001 going-away so the client knows to
      // reconnect on its own timer once the server is back.
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
    this.rooms.clear()
  }

  private async joinOrCreate(documentId: string, peer: Peer): Promise<Room> {
    const existing = this.rooms.get(documentId)
    if (existing) {
      // Wait for the in-flight hydration to complete so the peer sees
      // the same doc state as everyone else at their first sync tick.
      await existing.hydrated
      return existing
    }

    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    // Server has no local awareness state — clear the auto-registered
    // client from being broadcast; peers register themselves.
    awareness.setLocalState(null)

    const room: Room = {
      doc,
      awareness,
      peers: new Set(),
      dirty: false,
      lastEditor: null,
      autoTimer: null,
      persistInFlight: false,
      hydrated: Promise.resolve(),
    }
    this.rooms.set(documentId, room)

    room.hydrated = this.hydrate(documentId, room).catch((err) => {
      this.opts.logger.error({ err, docId: documentId }, 'ws: hydrate failed')
    })
    await room.hydrated

    // Any update the doc receives — from a peer applyUpdate, from
    // hydration, or from any other origin — fans out to every peer
    // whose socket did not originate the change. `origin` is the peer
    // that sent us the update (or `null` for hydration).
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

    // Awareness deltas: relay to every peer except the sender. Absent
    // clients (someone whose tab closed) get an implicit removeStates
    // via the same delta encoding.
    awareness.on('update', (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
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

    room.autoTimer = setInterval(() => {
      // Fire-and-forget — errors are logged inside persist. The timer
      // does not await, so a slow save cannot pile up further ticks.
      void this.persistIfDirty(documentId, room)
    }, this.opts.autoSnapshotIntervalMs)
    return room
  }

  private async hydrate(documentId: string, room: Room): Promise<void> {
    const row = await this.pool.query<{ yjs_state: Buffer }>(
      `SELECT yjs_state FROM document_snapshots
        WHERE document_id = $1
        ORDER BY saved_at DESC
        LIMIT 1`,
      [documentId],
    )
    if (row.rowCount === 0) return
    // Apply with a hydrate origin so the room's own update listener
    // does not treat this as a peer edit worth broadcasting.
    Y.applyUpdate(room.doc, row.rows[0]!.yjs_state, 'hydrate')
  }

  private attachPeer(documentId: string, room: Room, peer: Peer): void {
    room.peers.add(peer)

    // Kick off the sync: send our state vector so the peer can compute
    // what it lacks. Peer will reply with a SyncStep2 (update) and its
    // own SyncStep1; we handle both in messageHandler.
    const syncEncoder = encoding.createEncoder()
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC)
    writeSyncStep1(syncEncoder, room.doc)
    peer.socket.send(encoding.toUint8Array(syncEncoder))

    // If there is any current awareness state, send it so the peer
    // immediately renders other users' cursors.
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

  private handleMessage(
    documentId: string,
    room: Room,
    peer: Peer,
    bytes: Uint8Array,
  ): void {
    let decoder: decoding.Decoder
    let messageType: number
    try {
      decoder = decoding.createDecoder(bytes)
      messageType = decoding.readVarUint(decoder)
    } catch (err) {
      this.opts.logger.debug({ err, docId: documentId }, 'ws: malformed frame')
      return
    }

    switch (messageType) {
      case MESSAGE_SYNC: {
        // A viewer trying to push doc updates is a protocol violation
        // — silently drop. writeUpdate + applyUpdate must not run for
        // read-only peers. Note: SyncStep1 is a read (the peer is
        // asking us for our state), and viewers are entitled to that;
        // so allow SyncStep1 through but block SyncStep2 / SyncUpdate.
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        if (peer.role === 'viewer') {
          // Peek the sub-type without consuming from the shared
          // decoder — construct a second view.
          const peek = decoding.createDecoder(bytes)
          decoding.readVarUint(peek) // skip outer type
          const subType = decoding.readVarUint(peek)
          if (subType !== 0 /* SyncStep1 */) {
            this.opts.logger.warn(
              { docId: documentId, userId: peer.userId },
              'ws: viewer attempted a doc write; ignoring',
            )
            return
          }
        }
        // readSyncMessage applies updates to room.doc using `peer` as
        // origin — the doc.on('update') fan-out uses that to skip the
        // sender.
        readSyncMessage(decoder, encoder, room.doc, peer)
        if (encoding.length(encoder) > 1) {
          peer.socket.send(encoding.toUint8Array(encoder))
        }
        if (peer.role !== 'viewer') {
          room.dirty = true
          room.lastEditor = { id: peer.userId, printedName: peer.printedName }
        }
        break
      }
      case MESSAGE_AWARENESS: {
        // Awareness relay is allowed for every role — a viewer's
        // cursor is safe to share.
        try {
          applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), peer)
        } catch (err) {
          this.opts.logger.debug({ err, docId: documentId }, 'ws: awareness apply failed')
        }
        break
      }
      default:
        // Unknown top-level type — ignore. y-protocols occasionally
        // adds auth (2) / queryAwareness (3); we don't speak them yet.
        this.opts.logger.debug({ messageType, docId: documentId }, 'ws: unknown message type')
    }
  }

  private async handlePeerLeave(documentId: string, room: Room, peer: Peer): Promise<void> {
    room.peers.delete(peer)
    // Withdraw the peer's awareness so remaining peers see their cursor
    // disappear immediately, rather than waiting for the client's own
    // beforeunload cleanup which browsers do not guarantee.
    const clients = Array.from(room.awareness.getStates().keys())
    if (clients.length > 0) {
      removeAwarenessStates(
        room.awareness,
        clients.filter((cid) => cid === (peer as unknown as { clientID?: number }).clientID),
        peer,
      )
    }

    if (room.peers.size > 0) return

    // Last peer gone. Persist if there is anything worth saving, then
    // tear the room down — unless a new peer joined during the save,
    // in which case we leave the room in place.
    if (room.autoTimer) clearInterval(room.autoTimer)
    room.autoTimer = null

    try {
      await this.persistIfDirty(documentId, room)
    } catch (err) {
      this.opts.logger.error({ err, docId: documentId }, 'ws: last-peer flush failed')
    }

    if (room.peers.size === 0) {
      // Detach doc listeners so the GC can drop this Y.Doc rather
      // than keep it alive through the awareness handler closure.
      room.doc.destroy()
      this.rooms.delete(documentId)
    }
  }

  private async persistIfDirty(documentId: string, room: Room): Promise<void> {
    if (!room.dirty || room.persistInFlight || !room.lastEditor) return
    await this.persist(documentId, room)
  }

  private async persist(documentId: string, room: Room): Promise<void> {
    if (!room.dirty || !room.lastEditor) return
    room.persistInFlight = true
    try {
      const state = Y.encodeStateAsUpdate(room.doc)
      // Node's Buffer view onto the same bytes — no copy. saveSnapshot
      // stores as BYTEA which pg accepts either shape.
      const buf = Buffer.from(state.buffer, state.byteOffset, state.byteLength)
      await saveSnapshot(this.pool, documentId, buf, {
        reason: 'auto',
        label: null,
        userReason: null,
        actor: { id: room.lastEditor.id, printedName: room.lastEditor.printedName },
      })
      room.dirty = false
    } finally {
      room.persistInFlight = false
    }
  }

  /** Test-only accessor: how many rooms are live? Kept public so
   *  integration tests can assert the last-peer cleanup ran. */
  public roomCount(): number {
    return this.rooms.size
  }

  /** Test-only accessor: is the given document's room dirty? */
  public isDirty(documentId: string): boolean {
    return this.rooms.get(documentId)?.dirty ?? false
  }
}
