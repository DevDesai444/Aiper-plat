import type { FastifyInstance, FastifyRequest } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import type WebSocket from 'ws'
import type pg from 'pg'
import { z } from 'zod'
import type { AiperRole, SessionUser } from '@aiper/shared/types'
import type { Config } from '../config.js'
import { buildVerifier, type JwtVerifier } from '../auth/jwt.js'
import { RoomRegistry, type Peer, type PeerSocket } from './rooms.js'

/**
 * WebSocket handshake for /ws.
 *
 * The client cannot set custom headers on a browser WebSocket, so both
 * the auth token and the room's document id are query parameters:
 *
 *   /ws?token=<supabase-jwt>&doc=<document-uuid>
 *
 * Close codes on rejection (all in the 4xxx application-code range):
 *   4001 bad_token   — JWT missing, malformed, expired, or issued by
 *                      the wrong project. Same verifier as HTTP.
 *   4003 no_access   — token verified, but the caller has no grant on
 *                      the document (also fires for a document that
 *                      does not exist — the two collapse to hide
 *                      existence from an unauthorised caller).
 *   4400 bad_request — token or doc missing / not a UUID / query
 *                      parse failure.
 *
 * On success:
 *   - Role is fixed for the life of the connection at the highest role
 *     the resolver walked to. A grant change during the session does
 *     not update the role; the peer must reconnect.
 *   - 'viewer' peers can SEND awareness deltas and RECEIVE sync
 *     updates, but any doc write from them is silently dropped by the
 *     registry (see rooms.ts).
 *   - 'editor' / 'owner' peers get full read-write.
 *
 * After a successful handshake the socket speaks y-protocols exactly:
 *   byte 0 varuint = messageType   (0 = SYNC, 1 = AWARENESS)
 *   SYNC subtypes  (0 = SyncStep1, 1 = SyncStep2, 2 = SyncUpdate) per
 *   y-protocols/sync. Awareness updates are y-protocols/awareness
 *   encodeAwarenessUpdate frames.
 *
 * Redis fan-out for multi-instance deployments is a Phase-5 concern;
 * single-instance in-memory rooms are fine for MVP.
 */

const QuerySchema = z.object({
  token: z.string().min(1),
  doc: z.string().uuid(),
})

const CLOSE_BAD_TOKEN = 4001
const CLOSE_NO_ACCESS = 4003
const CLOSE_BAD_REQUEST = 4400

/** Cap the WebSocket frame size well above a realistic Yjs update but
 *  well below the ws default of 100 MiB — the default is an easy OOM
 *  vector on a public endpoint. 4 MiB comfortably fits every doc we
 *  have seen in v1 telemetry. */
const WS_MAX_PAYLOAD = 4 * 1024 * 1024

/** Ping every 30 s; if a client misses two consecutive pongs (60 s
 *  wall-clock), assume the socket is half-dead and terminate. Without
 *  this a client whose TCP stack silently died holds a room open until
 *  the OS-level keepalive fires (minutes to hours). */
const WS_PING_INTERVAL_MS = 30_000

function normaliseFrame(data: WebSocket.RawData): Uint8Array {
  // ws may deliver a Buffer, an array of Buffers, or an ArrayBuffer —
  // normalise to one Uint8Array so the registry only speaks one type.
  if (data instanceof Buffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (Array.isArray(data)) {
    const total = data.reduce((n, b) => n + b.byteLength, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const b of data) {
      merged.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off)
      off += b.byteLength
    }
    return merged
  }
  return new Uint8Array(data)
}

/**
 * Adapt a `ws` WebSocket to the PeerSocket surface the registry uses,
 * while draining any frames that arrived before the registry attached
 * its real message handler.
 *
 * Node's EventEmitter does not queue: a 'message' event fired before a
 * listener is attached is a silent no-op. The route handler does async
 * work (JWT verify, access check, DB round-trip) between accept and
 * registry.connect, and a browser client that sends immediately after
 * 'open' can land bytes on the socket in that window. We attach the
 * listener synchronously at the top of the handler, buffer frames into
 * `pending`, and flush them the moment the registry hooks its own
 * handler up via onMessage().
 */
function toPeerSocketWithBuffer(socket: WebSocket): PeerSocket {
  const pending: Uint8Array[] = []
  let realHandler: ((bytes: Uint8Array) => void) | null = null

  socket.on('message', (data, isBinary) => {
    if (!isBinary) return
    const bytes = normaliseFrame(data)
    if (realHandler) realHandler(bytes)
    else pending.push(bytes)
  })

  return {
    send(bytes) {
      socket.send(bytes)
    },
    close(code, reason) {
      socket.close(code, reason)
    },
    onMessage(handler) {
      realHandler = handler
      // Drain in FIFO order so a SyncStep1 that raced ahead of the
      // access check still lands before any subsequent update the
      // client sent.
      for (const b of pending) handler(b)
      pending.length = 0
    },
    onClose(handler) {
      socket.on('close', () => handler())
    },
  }
}

async function verifyOrClose(
  verifier: JwtVerifier,
  socket: WebSocket,
  token: string,
): Promise<SessionUser | null> {
  try {
    return await verifier.verify(token)
  } catch {
    socket.close(CLOSE_BAD_TOKEN, 'bad token')
    return null
  }
}

async function accessOrClose(
  pool: pg.Pool,
  socket: WebSocket,
  userId: string,
  documentId: string,
): Promise<AiperRole | null> {
  const r = await pool.query<{ role: AiperRole | null }>(
    `SELECT aiper_effective_access($1, 'document', $2) AS role`,
    [userId, documentId],
  )
  const role = r.rows[0]?.role ?? null
  if (role === null) {
    // Same 404-equivalent guard as POST /save: non-existent document
    // and no-grant-at-all collapse to one close code so the URL cannot
    // be enumerated.
    socket.close(CLOSE_NO_ACCESS, 'no access')
    return null
  }
  return role
}

export function registerWsRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: Config,
): void {
  const verifier = buildVerifier(config)
  const registry = new RoomRegistry(pool, {
    autoSnapshotIntervalMs: config.SNAPSHOT_AUTO_INTERVAL_MS,
    logger: app.log,
  })

  // Close every room and every peer socket cleanly when Fastify closes
  // — tests rely on this; production too during graceful shutdown.
  app.addHook('onClose', async () => {
    await registry.shutdown()
  })

  // Each socket's liveness flag lives in a WeakMap so we do not have to
  // extend the WebSocket type; on 'pong' we mark alive, on each tick
  // we mark not-alive and ping, and the next tick terminates anything
  // still not-alive. Node's ws does not do this on its own.
  const alive = new WeakMap<WebSocket, boolean>()

  // @fastify/websocket registers with Fastify BEFORE any route uses
  // { websocket: true }; safe to await inside this synchronous
  // register function because Fastify serialises plugin registration.
  void app.register(async (scope) => {
    await scope.register(websocketPlugin, {
      options: { maxPayload: WS_MAX_PAYLOAD },
    })

    const keepalive = setInterval(() => {
      for (const ws of scope.websocketServer.clients) {
        if (alive.get(ws) === false) {
          ws.terminate()
          continue
        }
        alive.set(ws, false)
        try {
          ws.ping()
        } catch {
          // socket is dead already; the terminate on next tick catches it
        }
      }
    }, WS_PING_INTERVAL_MS)
    scope.addHook('onClose', async () => {
      clearInterval(keepalive)
    })

    scope.get('/ws', { websocket: true }, async (socket, req: FastifyRequest) => {
      alive.set(socket, true)
      socket.on('pong', () => alive.set(socket, true))

      const parsed = QuerySchema.safeParse(req.query)
      if (!parsed.success) {
        socket.close(CLOSE_BAD_REQUEST, 'bad request')
        return
      }
      const { token, doc } = parsed.data

      // Attach the buffer listener synchronously — a fast client can
      // send its first sync frame before verify+access resolve. See
      // toPeerSocketWithBuffer for why this matters.
      const peerSocket = toPeerSocketWithBuffer(socket)

      const user = await verifyOrClose(verifier, socket, token)
      if (!user) return

      const role = await accessOrClose(pool, socket, user.id, doc)
      if (!role) return

      const peer: Peer = {
        userId: user.id,
        printedName: user.displayName,
        role,
        socket: peerSocket,
      }
      await registry.connect(doc, peer)
    })
  })
}
