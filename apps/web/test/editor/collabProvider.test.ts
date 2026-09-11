import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import {
  AiperCollabProvider,
  type WebSocketLike,
} from '../../src/editor/collabProvider'

/**
 * Bare-minimum in-process WebSocket double. Enough to drive the
 * provider through the states the real socket goes through — open,
 * message, close — plus a `.peer` link so two fakes can shuttle
 * frames between each other like the server would.
 */
class FakeWS implements WebSocketLike {
  readyState = 0 // CONNECTING
  binaryType: BinaryType = 'blob'
  peer: FakeWS | null = null
  sent: Uint8Array[] = []
  private listeners = new Map<string, Set<(ev: Event) => void>>()

  addEventListener(type: string, listener: (ev: Event) => void): void {
    let s = this.listeners.get(type)
    if (!s) {
      s = new Set()
      this.listeners.set(type, s)
    }
    s.add(listener)
  }
  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  private dispatch(type: string, ev: Event): void {
    // Copy to a local array to survive listeners that call removeEventListener.
    for (const l of Array.from(this.listeners.get(type) ?? [])) l(ev)
  }

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (this.readyState !== 1) return
    const bytes = normalise(data)
    this.sent.push(bytes)
    const peer = this.peer
    if (!peer || peer.readyState !== 1) return
    // Microtask-defer so tests can await Promise.resolve() and see the
    // frame reach the peer, matching browser behaviour where a message
    // event is dispatched asynchronously.
    queueMicrotask(() => {
      // Copy so the peer's onMessage handling can't mutate our record.
      const copy = new Uint8Array(bytes)
      peer.dispatch('message', new MessageEvent('message', { data: copy.buffer }))
    })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch(
      'close',
      new CloseEvent('close', { code, reason }),
    )
  }

  // Test helpers.
  simulateOpen(): void {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.dispatch('open', new Event('open'))
  }
  simulateClose(code: number, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', new CloseEvent('close', { code, reason }))
  }
}

function normalise(data: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  const view = data
  return new Uint8Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
  )
}

function pair(): [FakeWS, FakeWS] {
  const a = new FakeWS()
  const b = new FakeWS()
  a.peer = b
  b.peer = a
  return [a, b]
}

async function flush(ms = 20): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const DID = '12345678-1234-4234-8234-123456789abc'

describe('AiperCollabProvider', () => {
  it('sends SyncStep1 on open (varuint 0 SYNC, subtype 0)', async () => {
    const ws = new FakeWS()
    const ydoc = new Y.Doc()
    const provider = new AiperCollabProvider({
      ydoc,
      awareness: new Awareness(ydoc),
      documentId: DID,
      editable: true,
      getToken: async () => 'test-token',
      wsFactory: () => ws,
    })
    await flush()
    ws.simulateOpen()
    await flush()

    // At least one frame — the initial SyncStep1.
    expect(ws.sent.length).toBeGreaterThanOrEqual(1)
    const first = ws.sent[0]!
    const dec = decoding.createDecoder(first)
    expect(decoding.readVarUint(dec)).toBe(0) // MESSAGE_SYNC
    expect(decoding.readVarUint(dec)).toBe(0) // SyncStep1 subtype

    provider.destroy()
  })

  it('two paired providers converge their Y.Docs', async () => {
    const [wsA, wsB] = pair()
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const pA = new AiperCollabProvider({
      ydoc: docA,
      awareness: new Awareness(docA),
      documentId: DID,
      editable: true,
      getToken: async () => 'ta',
      wsFactory: () => wsA,
    })
    const pB = new AiperCollabProvider({
      ydoc: docB,
      awareness: new Awareness(docB),
      documentId: DID,
      editable: true,
      getToken: async () => 'tb',
      wsFactory: () => wsB,
    })
    await flush()
    wsA.simulateOpen()
    wsB.simulateOpen()
    // Let the initial SyncStep1 exchange settle.
    await flush(30)

    // A writes into its ydoc.
    docA.transact(() => {
      const frag = docA.getXmlFragment('default')
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('hello from A')])
      frag.insert(0, [p])
    })

    await flush(30)

    expect(docB.getXmlFragment('default').toString()).toContain('hello from A')

    pA.destroy()
    pB.destroy()
  })

  it('does not reconnect on 4003 no_access — the state goes terminal', async () => {
    let factoryCalls = 0
    let firstWs: FakeWS | null = null
    const errors: unknown[] = []
    const provider = new AiperCollabProvider({
      ydoc: new Y.Doc(),
      awareness: new Awareness(new Y.Doc()),
      documentId: DID,
      editable: true,
      getToken: async () => 'tok',
      reconnectBaseMs: 5,
      onError: (e) => errors.push(e),
      wsFactory: () => {
        factoryCalls += 1
        const ws = new FakeWS()
        if (!firstWs) firstWs = ws
        queueMicrotask(() => ws.simulateClose(4003, 'no access'))
        return ws
      },
    })
    await flush(80)

    expect(factoryCalls).toBe(1)
    expect(provider.getStatus()).toBe('terminal')
    expect(errors.some((e) => (e as { code: string }).code === 'no_access')).toBe(
      true,
    )

    provider.destroy()
  })

  it('reconnects with backoff on abnormal (1006) close', async () => {
    let factoryCalls = 0
    const provider = new AiperCollabProvider({
      ydoc: new Y.Doc(),
      awareness: new Awareness(new Y.Doc()),
      documentId: DID,
      editable: true,
      getToken: async () => 'tok',
      reconnectBaseMs: 5, // fast backoff for the test
      reconnectMaxMs: 50,
      wsFactory: () => {
        factoryCalls += 1
        const ws = new FakeWS()
        // Every attempt fails immediately with an abnormal close so the
        // provider schedules another reconnect after each attempt.
        queueMicrotask(() => ws.simulateClose(1006))
        return ws
      },
    })
    // 3× the base backoff is plenty of budget for at least two attempts.
    await flush(120)
    expect(factoryCalls).toBeGreaterThan(1)
    provider.destroy()
  })

  it('viewer role does not broadcast local doc updates (belt-and-suspenders)', async () => {
    const ws = new FakeWS()
    const ydoc = new Y.Doc()
    const provider = new AiperCollabProvider({
      ydoc,
      awareness: new Awareness(ydoc),
      documentId: DID,
      editable: false, // viewer
      getToken: async () => 'tok',
      wsFactory: () => ws,
    })
    await flush()
    ws.simulateOpen()
    await flush()
    const sentBeforeEdit = ws.sent.length

    // A local doc write on a viewer client (should not happen in prod
    // because TipTap is editable:false too, but we defend the wire).
    ydoc.transact(() => {
      const frag = ydoc.getXmlFragment('default')
      frag.insert(0, [new Y.XmlElement('paragraph')])
    })
    await flush()

    // No new frames beyond the initial SyncStep1.
    expect(ws.sent.length).toBe(sentBeforeEdit)

    provider.destroy()
  })

  it('destroy() closes the socket and detaches doc listeners', async () => {
    const ws = new FakeWS()
    const ydoc = new Y.Doc()
    const provider = new AiperCollabProvider({
      ydoc,
      awareness: new Awareness(ydoc),
      documentId: DID,
      editable: true,
      getToken: async () => 'tok',
      wsFactory: () => ws,
    })
    await flush()
    ws.simulateOpen()
    await flush()

    provider.destroy()
    expect(ws.readyState).toBe(3) // CLOSED

    // Post-destroy edit does not touch the wire (the socket is closed,
    // and the listener is detached anyway).
    const sentBeforeEdit = ws.sent.length
    ydoc.transact(() => {
      ydoc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
    })
    await flush()
    expect(ws.sent.length).toBe(sentBeforeEdit)
  })

  it('emits no_session (terminal) when getToken returns null', async () => {
    let factoryCalls = 0
    const errors: unknown[] = []
    const provider = new AiperCollabProvider({
      ydoc: new Y.Doc(),
      awareness: new Awareness(new Y.Doc()),
      documentId: DID,
      editable: true,
      getToken: async () => null,
      onError: (e) => errors.push(e),
      wsFactory: () => {
        factoryCalls += 1
        return new FakeWS()
      },
    })
    await flush()
    expect(factoryCalls).toBe(0)
    expect(provider.getStatus()).toBe('terminal')
    expect(errors[0]).toMatchObject({ code: 'no_session' })
    provider.destroy()
  })
})
