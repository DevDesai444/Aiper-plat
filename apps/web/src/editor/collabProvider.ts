import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

/**
 * ─── Aiper Yjs WebSocket provider ────────────────────────────────────────────
 *
 * y-websocket's stock `WebsocketProvider` puts the room name in the URL
 * path (`ws://host/<room>`) and carries no auth token; the Aiper server
 * requires `wss://host/ws?token=<jwt>&doc=<uuid>` and rejects anything
 * else with close code `4400`. Browsers cannot set an `Authorization`
 * header on a WebSocket, so the token has to ride in the query string
 * (server's PR #18 contract, spelled out in apps/server/src/ws/index.ts).
 *
 * Consequence: we hand-roll a small provider against the same
 * y-protocols wire the server speaks, rather than pulling in
 * y-websocket and layering hacks on top of it.
 *
 * Handshake close codes surfaced to callers via `onError`:
 *   4001 bad_token   — JWT missing / invalid / expired / wrong project.
 *                      Reconnect: yes (Supabase refreshes on its own
 *                      tick, so the next `getToken()` may hand us a
 *                      fresh one).
 *   4003 no_access   — token verified, no grant on the document
 *                      (collapses with "document does not exist" per
 *                      the server's existence-leak guard). Reconnect:
 *                      NO — terminal.
 *   4400 bad_request — client sent a malformed handshake. Reconnect:
 *                      NO — terminal (would be a client bug).
 *   any other close  — transient (1006, network drop, server restart).
 *                      Reconnect: yes, with exponential backoff
 *                      (~500 ms → ~30 s, plus jitter).
 *
 * Wire (after handshake), per y-protocols:
 *   frame = <varuint messageType> <payload>
 *   messageType: 0 SYNC (SyncStep1 / SyncStep2 / SyncUpdate per
 *                        y-protocols/sync)
 *                1 AWARENESS (encodeAwarenessUpdate payload)
 *
 * Design notes:
 *   • Local doc updates broadcast only when `editable === true`. Belt
 *     and suspenders: the server silently drops a viewer's SyncStep2 /
 *     SyncUpdate anyway (see rooms.ts), but why send garbage.
 *   • Awareness updates broadcast for every role — a viewer's cursor is
 *     safe to share and useful to show.
 *   • Doc + awareness updates apply INBOUND regardless of role.
 *   • The provider uses `this` as the `origin` on every `applyUpdate`
 *     and `applyAwarenessUpdate` call. Its own doc/awareness listeners
 *     skip updates whose origin is `this`, so remote frames do not
 *     bounce back to the server as echoes. The `'hydrate'` origin
 *     used by EditorPage's initial HTTP load is also skipped, matching
 *     the same string the server uses when it hydrates a room's Y.Doc.
 *   • The reconnect logic prefers a slower cadence to a faster one:
 *     when the server restarts, thousands of clients trying to
 *     reconnect in a tight loop would DDoS the freshly-booted server
 *     and delay recovery for everyone. `reconnectMaxMs = 30_000` caps
 *     the tail; jitter smooths the thundering herd.
 *   • Y.Doc and Awareness lifetimes are owned by the caller (usually
 *     EditorPage). `destroy()` here does NOT destroy them — it only
 *     detaches listeners and closes the socket. Doing otherwise would
 *     break the CollaborationCursor extension, which reads from the
 *     same Awareness the provider was handed.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/** WebSocket.OPEN mirrored so we don't pull `WebSocket` into node tests. */
const READY_STATE_OPEN = 1

export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'terminal'

export type CollabErrorCode =
  | 'bad_token'   // WS 4001 — will retry
  | 'no_access'   // WS 4003 — terminal
  | 'bad_request' // WS 4400 — terminal
  | 'no_session'  // getToken returned null; terminal
  | 'transient'   // network / abnormal close; will retry
  | 'unknown'

export interface CollabError {
  code: CollabErrorCode
  message: string
  /** Present on close-code-driven errors, so callers can log the raw code. */
  wsCloseCode?: number
}

/**
 * The subset of `WebSocket` the provider actually uses. Kept small on
 * purpose — tests plug in an in-process fake by way of `wsFactory`, and
 * the fake only has to implement this surface. Add fields with care;
 * every one is one more thing a test double has to mimic correctly.
 */
export interface WebSocketLike {
  readyState: number
  binaryType: BinaryType
  send(data: ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: Event) => void): void
  removeEventListener(type: string, listener: (ev: Event) => void): void
}

export interface AiperCollabOptions {
  ydoc: Y.Doc
  awareness: Awareness
  documentId: string
  /**
   * Whether local doc updates should broadcast to peers. Viewers pass
   * `false` (the server drops their writes silently, but we don't even
   * send them). Awareness (cursor position) always broadcasts.
   */
  editable: boolean
  /**
   * Called on every connect attempt (not cached), so a Supabase-
   * refreshed token is used automatically on reconnect after a `4001`.
   * Returning `null` means "no session" — terminal, no reconnect.
   */
  getToken(): Promise<string | null>
  /**
   * Base URL. Defaults to `/ws` on the current origin (Vite dev proxy
   * upgrades that to Fastify; prod serves the SPA from Fastify so the
   * same-origin `/ws` resolves straight to the ws server). Tests pass
   * a full URL, or use `wsFactory` to skip URL parsing entirely.
   */
  baseUrl?: string
  /** Testing seam. When provided, called instead of `new WebSocket(url)`. */
  wsFactory?: (url: string) => WebSocketLike
  onStatus?: (status: CollabStatus) => void
  onError?: (err: CollabError) => void
  /** Reconnect backoff base (ms). Default 500. Tests pass a small value. */
  reconnectBaseMs?: number
  /** Reconnect backoff cap (ms). Default 30 000. */
  reconnectMaxMs?: number
}

export class AiperCollabProvider {
  readonly awareness: Awareness
  private readonly opts: AiperCollabOptions
  private ws: WebSocketLike | null = null
  private closed = false
  private status: CollabStatus = 'connecting'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly docHandler: (u: Uint8Array, o: unknown) => void
  private readonly awarenessHandler: (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void

  constructor(opts: AiperCollabOptions) {
    this.opts = opts
    this.awareness = opts.awareness

    // Local → wire relays. Bound as instance fields (not methods on
    // prototype) so the same reference is used for on()/off() below.
    this.docHandler = (update, origin) => {
      // Skip: remote-applied frames (we set origin=this) and the load
      // path's hydrate origin. Everything else is a local user edit.
      if (origin === this || origin === 'hydrate') return
      if (!this.opts.editable) return
      const ws = this.ws
      if (!ws || ws.readyState !== READY_STATE_OPEN) return
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      writeUpdate(enc, update)
      ws.send(encoding.toUint8Array(enc))
    }
    this.opts.ydoc.on('update', this.docHandler)

    this.awarenessHandler = ({ added, updated, removed }, origin) => {
      // Same skip logic: our own applyAwarenessUpdate origin is `this`.
      // Local `setLocalState` origin is `null` (the awareness default),
      // so those broadcast correctly.
      if (origin === this) return
      const changed = added.concat(updated).concat(removed)
      const ws = this.ws
      if (!ws || ws.readyState !== READY_STATE_OPEN) return
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, changed))
      ws.send(encoding.toUint8Array(enc))
    }
    this.awareness.on('update', this.awarenessHandler)

    void this.connect()
  }

  getStatus(): CollabStatus {
    return this.status
  }

  /**
   * Detach listeners and close the socket. Idempotent. Does NOT touch
   * `ydoc` or `awareness` — those belong to the caller.
   */
  destroy(): void {
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.opts.ydoc.off('update', this.docHandler)
    this.awareness.off('update', this.awarenessHandler)
    this.closeSocket(1000, 'client destroy')
    // No status callback — the caller told us to close.
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws
    if (!ws) return
    try {
      ws.close(code, reason)
    } catch {
      /* socket was already gone */
    }
    ws.removeEventListener('open', this.onOpen)
    ws.removeEventListener('message', this.onMessage)
    ws.removeEventListener('close', this.onClose)
    ws.removeEventListener('error', this.onError)
    this.ws = null
  }

  private setStatus(next: CollabStatus): void {
    if (this.status === next) return
    this.status = next
    this.opts.onStatus?.(next)
  }

  private emit(err: CollabError): void {
    this.opts.onError?.(err)
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    this.setStatus('connecting')

    let token: string | null
    try {
      token = await this.opts.getToken()
    } catch {
      if (this.closed) return
      this.setStatus('disconnected')
      this.emit({ code: 'unknown', message: 'Failed to read auth token' })
      this.scheduleReconnect()
      return
    }
    if (this.closed) return
    if (!token) {
      this.setStatus('terminal')
      this.emit({ code: 'no_session', message: 'Not signed in' })
      return
    }

    const url = this.buildUrl(token)
    let ws: WebSocketLike
    try {
      ws = this.opts.wsFactory
        ? this.opts.wsFactory(url)
        : (new WebSocket(url) as unknown as WebSocketLike)
    } catch {
      if (this.closed) return
      this.setStatus('disconnected')
      this.emit({ code: 'transient', message: 'WebSocket constructor failed' })
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('open', this.onOpen)
    ws.addEventListener('message', this.onMessage)
    ws.addEventListener('close', this.onClose)
    ws.addEventListener('error', this.onError)
  }

  private buildUrl(token: string): string {
    const base = this.opts.baseUrl ?? '/ws'
    let url: URL
    if (/^wss?:\/\//i.test(base) || /^https?:\/\//i.test(base)) {
      url = new URL(base)
    } else {
      const locHref =
        typeof window !== 'undefined' && window.location
          ? window.location.href
          : 'http://localhost/'
      url = new URL(base, locHref)
    }
    // http(s) → ws(s). Same-origin relative URL always starts as http(s).
    if (url.protocol === 'https:') url.protocol = 'wss:'
    else if (url.protocol === 'http:') url.protocol = 'ws:'
    url.searchParams.set('token', token)
    url.searchParams.set('doc', this.opts.documentId)
    return url.toString()
  }

  private onOpen = (): void => {
    this.reconnectAttempt = 0
    this.setStatus('connected')
    const ws = this.ws
    if (!ws) return
    // Send our SyncStep1 so the server can compute the update we need.
    // Server also sends its own SyncStep1 on connect — one round trip
    // and both sides have equal state.
    {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      writeSyncStep1(enc, this.opts.ydoc)
      ws.send(encoding.toUint8Array(enc))
    }
    // Push our current awareness state so peers immediately render our
    // cursor. CollaborationCursor set the local state at editor mount.
    const clientIds = Array.from(this.awareness.getStates().keys())
    if (clientIds.length > 0) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        enc,
        encodeAwarenessUpdate(this.awareness, clientIds),
      )
      ws.send(encoding.toUint8Array(enc))
    }
  }

  private onMessage = (ev: Event): void => {
    const data = (ev as MessageEvent).data
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else {
      // Text frames are not our protocol. Ignore.
      return
    }
    let dec: decoding.Decoder
    let type: number
    try {
      dec = decoding.createDecoder(bytes)
      type = decoding.readVarUint(dec)
    } catch {
      return
    }
    try {
      if (type === MESSAGE_SYNC) {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MESSAGE_SYNC)
        // readSyncMessage applies to ydoc with `this` as origin — see
        // the docHandler above for how that skips echoes.
        readSyncMessage(dec, enc, this.opts.ydoc, this)
        if (encoding.length(enc) > 1) {
          this.ws?.send(encoding.toUint8Array(enc))
        }
      } else if (type === MESSAGE_AWARENESS) {
        applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(dec),
          this,
        )
      }
      // Unknown top-level types are ignored on purpose. y-protocols
      // reserves auth=2 and queryAwareness=3; the server does not send
      // them today and clients aren't expected to speak them either.
    } catch {
      // A malformed frame from the server is treated as data loss for
      // this one message, not a fatal error — stay connected, the next
      // frame may be fine.
    }
  }

  private onClose = (ev: Event): void => {
    const code = (ev as CloseEvent).code
    this.closeSocket(code, '')
    if (this.closed) return
    switch (code) {
      case 4001:
        this.emit({
          code: 'bad_token',
          message: 'Auth token invalid or expired',
          wsCloseCode: 4001,
        })
        this.setStatus('disconnected')
        this.scheduleReconnect()
        return
      case 4003:
        this.emit({
          code: 'no_access',
          message: 'No access to this document',
          wsCloseCode: 4003,
        })
        this.setStatus('terminal')
        return
      case 4400:
        this.emit({
          code: 'bad_request',
          message: 'Bad WebSocket handshake',
          wsCloseCode: 4400,
        })
        this.setStatus('terminal')
        return
      default:
        // 1006 abnormal, 1001 going-away, server restart, etc.
        this.emit({
          code: 'transient',
          message: `Connection closed (${code})`,
          wsCloseCode: code,
        })
        this.setStatus('disconnected')
        this.scheduleReconnect()
    }
  }

  private onError = (): void => {
    // The `error` event is always followed by `close` on browsers.
    // We let the close handler make the reconnect decision so the code
    // path is a single funnel.
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectTimer) return
    const attempt = ++this.reconnectAttempt
    const baseMs = this.opts.reconnectBaseMs ?? 500
    const maxMs = this.opts.reconnectMaxMs ?? 30_000
    const step = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 6))
    const jitter = Math.floor(Math.random() * baseMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, step + jitter)
  }
}

/**
 * Small util: pick a stable cursor colour for a user id. Consistent
 * per-user across sessions, distinct-enough within a small room. The
 * palette avoids the accent colour (`--color-accent`) so cursors don't
 * blend with the app chrome.
 */
export function collabCursorColorForUser(userId: string): string {
  const palette = [
    '#e57373', // red
    '#ff9800', // orange
    '#ffc107', // amber
    '#8bc34a', // lime
    '#4db6ac', // teal
    '#7986cb', // indigo
    '#ba68c8', // purple
    '#a1887f', // brown
  ]
  let h = 0
  for (let i = 0; i < userId.length; i += 1) {
    h = (h * 31 + userId.charCodeAt(i)) | 0
  }
  const idx = Math.abs(h) % palette.length
  return palette[idx] ?? palette[0]!
}
