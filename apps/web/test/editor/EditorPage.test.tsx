import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import * as Y from 'yjs'
import * as buffer from 'lib0/buffer'
import type { Document, SessionUser } from '@aiper/shared/types'
import { server } from '../msw/server'

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    auth: {
      getSession: vi.fn<
        () => Promise<{ data: { session: { access_token: string } | null } }>
      >(),
    },
  },
}))
vi.mock('../../src/auth/supabase', () => ({ supabase: mockSupabase }))

/**
 * Mock the collab provider so EditorPage tests do not try to spawn a
 * real `WebSocket` under jsdom. The mock records constructor args and
 * lets us assert that:
 *   1. EditorPage constructs it exactly when it should (session user
 *      present AND load resolved), and never otherwise.
 *   2. `destroy()` runs on unmount.
 *   3. `editable` gates the flag it hands the provider.
 * The wire-level behaviour is covered by test/editor/collabProvider.
 */
const collabMock = vi.hoisted(() => {
  interface MockInstance {
    opts: { documentId: string; editable: boolean; awareness: unknown }
    destroy: ReturnType<typeof vi.fn>
  }
  const instances: MockInstance[] = []
  class MockProvider {
    opts: MockInstance['opts']
    awareness: unknown
    destroy: MockInstance['destroy']
    constructor(opts: {
      documentId: string
      editable: boolean
      awareness: unknown
      onStatus?: (s: string) => void
    }) {
      this.opts = { documentId: opts.documentId, editable: opts.editable, awareness: opts.awareness }
      this.awareness = opts.awareness
      this.destroy = vi.fn()
      instances.push(this as unknown as MockInstance)
      queueMicrotask(() => opts.onStatus?.('connected'))
    }
    getStatus(): string { return 'connected' }
  }
  return { instances, MockProvider }
})
vi.mock('../../src/editor/collabProvider', () => ({
  AiperCollabProvider: collabMock.MockProvider,
  collabCursorColorForUser: () => '#749dc4',
}))

/**
 * Mock the docx importer so EditorPage's Import DOCX flow can be
 * exercised without pulling mammoth (a ~1 MB dep) into the vitest
 * environment. The wire between EditorPage and mammoth is covered
 * end-to-end in `docxImport.test.ts`; this test file cares about
 * the confirm-before-replace flow, the role gate, and that the
 * imported HTML lands in the editor.
 */
const importMock = vi.hoisted(() => ({
  convertDocxToHtml: vi.fn<
    (source: File | Blob | ArrayBuffer) => Promise<{
      html: string
      warnings: string[]
    }>
  >(),
}))
vi.mock('../../src/editor/docxImport', () => importMock)

// Dynamic import after mocks so the editor module resolves them.
const { EditorPage } = await import('../../src/editor/EditorPage')
const { useSessionStore } = await import('../../src/auth/sessionStore')

const DID = '33333333-3333-4333-8333-333333333333'
const PID = '44444444-4444-4444-8444-444444444444'
const FID = '55555555-5555-4555-8555-555555555555'
const SID = '66666666-6666-4666-8666-666666666666'
const USER_ID = '11111111-1111-4111-8111-111111111111'

function fakeSessionUser(): SessionUser {
  return {
    id: USER_ID,
    email: 'alice@example.com',
    displayName: 'Alice',
    avatarUrl: null,
    orgMemberships: [],
  }
}

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: DID,
    folderId: FID,
    projectId: PID,
    title: 'Thermal Vacuum Report',
    kind: 'authored',
    currentSnapshotId: null,
    createdBy: USER_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    myRole: 'editor',
    ...overrides,
  }
}

/**
 * Build a real Y.Doc holding one paragraph of text, encoded through the
 * same fragment field (`Y_DOC_FRAGMENT_FIELD = 'default'`) EditorPage
 * binds Collaboration to. Any drift between this fixture and the
 * production fragment name would show as an empty editor here — hence
 * the imported constant in the assertions below.
 */
function makeYjsBytesWith(text: string): Uint8Array {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(text)])
  frag.insert(0, [paragraph])
  return Y.encodeStateAsUpdate(doc)
}

function renderAt(path: string): { unmount: () => void } {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="p/:pid/f/:fid/d/:did" element={<EditorPage />} />
        <Route path="p/:pid/d/:did" element={<EditorPage />} />
      </Routes>
    </MemoryRouter>,
  )
  return { unmount: utils.unmount }
}

beforeEach(() => {
  mockSupabase.auth.getSession.mockReset()
  mockSupabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  })
  collabMock.instances.length = 0
  importMock.convertDocxToHtml.mockReset()
  importMock.convertDocxToHtml.mockResolvedValue({ html: '', warnings: [] })
  // Session store starts empty per test unless explicitly seeded — the
  // provider effect early-returns when there's no cursor identity, so
  // load/save tests keep behaving exactly as they did before PR-3.
  useSessionStore.setState({
    status: 'signed-out',
    user: null,
    error: null,
    busy: false,
  })
})

describe('EditorPage', () => {
  it('renders title + hydrated snapshot bytes at the folder-parented route', async () => {
    const bytes = makeYjsBytesWith('Hello satellite editor')
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ currentSnapshotId: SID })),
      ),
      http.get(
        `/api/v1/documents/${DID}/snapshots/${SID}/state`,
        () =>
          new HttpResponse(bytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
      ),
    )

    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)

    // Title from Document metadata.
    expect(
      await screen.findByRole('heading', { name: /Thermal Vacuum Report/i }),
    ).toBeInTheDocument()
    // Body text from the hydrated Y.Doc — proves the Yjs bytes round-trip
    // through `Y.applyUpdate` + TipTap Collaboration's fragment binding.
    await waitFor(() => {
      expect(screen.getByText(/Hello satellite editor/)).toBeInTheDocument()
    })
    // The "back" link points to the parent folder for folder-parented docs.
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute(
      'href',
      `/p/${PID}/f/${FID}`,
    )
  })

  it('renders an empty editor without fetching /state when currentSnapshotId is null', async () => {
    let stateFetchCalled = false
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(
          makeDocument({ folderId: null, currentSnapshotId: null }),
        ),
      ),
      http.get(`/api/v1/documents/${DID}/snapshots/${SID}/state`, () => {
        stateFetchCalled = true
        return new HttpResponse(new Uint8Array(), { status: 200 })
      }),
    )

    renderAt(`/p/${PID}/d/${DID}`)

    // Project-parented route: the back link goes to the project overview.
    await screen.findByRole('heading', { name: /Thermal Vacuum Report/i })
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute(
      'href',
      `/p/${PID}`,
    )
    expect(stateFetchCalled).toBe(false)
  })

  it('shows the fail card when getDocument returns 404', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(
          { error: 'Not found', code: 'not_found' },
          { status: 404 },
        ),
      ),
    )

    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)

    expect(
      await screen.findByRole('heading', { name: /Could not open document/i }),
    ).toBeInTheDocument()
    // The ApiFetchError message includes the status prefix.
    expect(screen.getByText(/404/)).toBeInTheDocument()
    // Back link still routes to the parent folder from the fail card.
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute(
      'href',
      `/p/${PID}/f/${FID}`,
    )
  })

  // ─── PR-2: role-gated edit + Save ────────────────────────────────────────

  it('hides Save and shows "Read-only" for viewer role', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'viewer', currentSnapshotId: null })),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)

    await screen.findByRole('heading', { name: /Thermal Vacuum Report/i })
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument()
  })

  it('exposes Save for editor+ and POSTs a base64 body that round-trips through Y.applyUpdate', async () => {
    const hydrateBytes = makeYjsBytesWith('initial content from server')
    let receivedBody: unknown = null

    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: SID })),
      ),
      http.get(
        `/api/v1/documents/${DID}/snapshots/${SID}/state`,
        () =>
          new HttpResponse(hydrateBytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
      ),
      http.post(`/api/v1/documents/${DID}/save`, async ({ request }) => {
        receivedBody = await request.json()
        return HttpResponse.json({
          id: '77777777-7777-4777-8777-777777777777',
          documentId: DID,
          savedBy: USER_ID,
          savedAt: '2026-01-02T14:23:00.000Z',
          reason: 'checkpoint' as const,
          label: null,
        })
      }),
    )

    renderAt(`/p/${PID}/d/${DID}`)
    const saveBtn = await screen.findByRole('button', { name: 'Save' })
    // Wait for hydration to seed the ydoc — otherwise the base64 would be
    // an empty-doc state vector and the round-trip assertion would still
    // pass vacuously (empty in = empty out). Waiting for the text asserts
    // Collaboration finished pulling the hydrated fragment into the DOM.
    await waitFor(() => {
      expect(screen.getByText(/initial content from server/)).toBeInTheDocument()
    })

    await userEvent.click(saveBtn)

    await waitFor(() => {
      expect(receivedBody).not.toBeNull()
    })
    const body = receivedBody as { yjsState: string; reason?: unknown; label?: unknown }
    expect(typeof body.yjsState).toBe('string')
    // The server's SaveBodySchema rejects reason/label if present-but-not-string;
    // omitting them entirely (rather than sending null) matches the schema's
    // .optional() shape most cleanly.
    expect(body.reason).toBeUndefined()
    expect(body.label).toBeUndefined()

    // Decode the wire bytes, apply to a fresh Y.Doc, and assert the same
    // fragment holds the same text. Any drift in the base64 encoder or the
    // fragment field ('default') would break this equality.
    const wireBytes = buffer.fromBase64(body.yjsState)
    const decoded = new Y.Doc()
    Y.applyUpdate(decoded, wireBytes)
    expect(decoded.getXmlFragment('default').toString()).toContain(
      'initial content from server',
    )

    // Saved indicator picks up the server's ISO timestamp — locale-agnostic
    // regex tolerates 14:23 / 2:23 PM formats.
    await waitFor(() => {
      expect(screen.getByText(/Saved \d{1,2}:\d{2}/)).toBeInTheDocument()
    })
  })

  it('surfaces the server error when POST /save returns 403', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: null })),
      ),
      http.post(`/api/v1/documents/${DID}/save`, () =>
        HttpResponse.json(
          { error: 'This action requires editor or above.', code: 'insufficient_role' },
          { status: 403 },
        ),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)

    const saveBtn = await screen.findByRole('button', { name: 'Save' })
    await userEvent.click(saveBtn)

    // ApiFetchError.message = server error text; describeError prefixes status.
    await waitFor(() => {
      expect(screen.getByText(/Save failed — 403/)).toBeInTheDocument()
    })
  })

  it('fires save on Ctrl/Cmd-S for editor+', async () => {
    let saveHits = 0
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'owner', currentSnapshotId: null })),
      ),
      http.post(`/api/v1/documents/${DID}/save`, () => {
        saveHits += 1
        return HttpResponse.json({
          id: '77777777-7777-4777-8777-777777777777',
          documentId: DID,
          savedBy: USER_ID,
          savedAt: '2026-01-02T14:23:00.000Z',
          reason: 'checkpoint' as const,
          label: null,
        })
      }),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByRole('button', { name: 'Save' })

    // userEvent's keyboard API dispatches at window level, which is where
    // the EditorPage's Cmd-S listener is registered.
    await userEvent.keyboard('{Control>}s{/Control}')

    await waitFor(() => expect(saveHits).toBe(1))
  })

  // ─── PR-3: live-sync provider lifecycle ──────────────────────────────────

  it('does not spawn the collab provider when there is no session user', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: null })),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByRole('heading', { name: /Thermal Vacuum/i })
    // Provider stays off — no cursor identity, no connection dot.
    expect(collabMock.instances).toHaveLength(0)
    expect(screen.queryByRole('status', { name: /Live sync/i })).not.toBeInTheDocument()
  })

  it('spawns the collab provider after load and destroys it on unmount', async () => {
    useSessionStore.setState({ status: 'signed-in', user: fakeSessionUser(), error: null, busy: false })
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: null })),
      ),
    )
    const { unmount } = renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByRole('heading', { name: /Thermal Vacuum/i })

    await waitFor(() => expect(collabMock.instances).toHaveLength(1))
    const instance = collabMock.instances[0]!
    expect(instance.opts.documentId).toBe(DID)
    expect(instance.opts.editable).toBe(true) // editor role
    // Live-sync dot renders once the provider reports connected.
    await waitFor(() => {
      expect(
        screen.getByRole('status', { name: /Live sync connected/i }),
      ).toBeInTheDocument()
    })

    unmount()
    expect(instance.destroy).toHaveBeenCalled()
  })

  it('connects viewers too but with editable=false so they cannot broadcast writes', async () => {
    useSessionStore.setState({ status: 'signed-in', user: fakeSessionUser(), error: null, busy: false })
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'viewer', currentSnapshotId: null })),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByRole('heading', { name: /Thermal Vacuum/i })

    await waitFor(() => expect(collabMock.instances).toHaveLength(1))
    expect(collabMock.instances[0]!.opts.editable).toBe(false)
    // Viewer titlebar still says Read-only for save; live-sync dot is
    // separate and reflects the WS connection.
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument()
  })

  // ─── PR-6: DOCX import ───────────────────────────────────────────────────

  it('viewer role hides the Import DOCX button', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'viewer', currentSnapshotId: null })),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByRole('heading', { name: /Thermal Vacuum/i })
    expect(
      screen.queryByRole('button', { name: /Import DOCX/i }),
    ).not.toBeInTheDocument()
    // Sanity: Export is still available to viewers (it just reads).
    expect(screen.getByRole('button', { name: /Export DOCX/i })).toBeInTheDocument()
  })

  it('editor with an empty doc imports without a confirm dialog', async () => {
    importMock.convertDocxToHtml.mockResolvedValue({
      html: '<h1>Imported heading</h1><p>Imported body</p>',
      warnings: [],
    })
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: null })),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByRole('button', { name: /Import DOCX/i })

    const fileInput = screen.getByTestId('editor-import-input') as HTMLInputElement
    const file = new File(['fake bytes'], 'inbound.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    await userEvent.upload(fileInput, file)

    // Import runs immediately — no confirm on an empty doc.
    await waitFor(() =>
      expect(importMock.convertDocxToHtml).toHaveBeenCalledTimes(1),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The imported HTML lands in the editor via setContent.
    await waitFor(() => {
      expect(screen.getByText(/Imported heading/)).toBeInTheDocument()
    })
    expect(screen.getByText(/Imported body/)).toBeInTheDocument()
  })

  it('editor with a non-empty doc opens ConfirmDialog first; cancel skips import', async () => {
    const hydrateBytes = makeYjsBytesWith('existing content — do not clobber')
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: SID })),
      ),
      http.get(
        `/api/v1/documents/${DID}/snapshots/${SID}/state`,
        () =>
          new HttpResponse(hydrateBytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByText(/existing content — do not clobber/)

    const fileInput = screen.getByTestId('editor-import-input') as HTMLInputElement
    const file = new File(['x'], 'inbound.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    await userEvent.upload(fileInput, file)

    // ConfirmDialog is up; import has NOT been called yet.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(importMock.convertDocxToHtml).not.toHaveBeenCalled()
    // Cancel closes the dialog without importing.
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(importMock.convertDocxToHtml).not.toHaveBeenCalled()
    // The original hydrated content is still on screen.
    expect(
      screen.getByText(/existing content — do not clobber/),
    ).toBeInTheDocument()
  })

  it('editor with a non-empty doc: ConfirmDialog Replace-and-import triggers the import', async () => {
    const hydrateBytes = makeYjsBytesWith('before import')
    importMock.convertDocxToHtml.mockResolvedValue({
      html: '<p>after import</p>',
      warnings: [],
    })
    server.use(
      http.get(`/api/v1/documents/${DID}`, () =>
        HttpResponse.json(makeDocument({ myRole: 'editor', currentSnapshotId: SID })),
      ),
      http.get(
        `/api/v1/documents/${DID}/snapshots/${SID}/state`,
        () =>
          new HttpResponse(hydrateBytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
      ),
    )
    renderAt(`/p/${PID}/f/${FID}/d/${DID}`)
    await screen.findByText(/before import/)

    const fileInput = screen.getByTestId('editor-import-input') as HTMLInputElement
    const file = new File(['x'], 'inbound.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    await userEvent.upload(fileInput, file)

    // Confirm dialog is up — click "Replace and import".
    await screen.findByRole('dialog')
    await userEvent.click(
      screen.getByRole('button', { name: /Replace and import/i }),
    )

    await waitFor(() =>
      expect(importMock.convertDocxToHtml).toHaveBeenCalledTimes(1),
    )
    // The imported HTML has replaced the pre-existing content.
    await waitFor(() => {
      expect(screen.getByText(/after import/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/before import/)).not.toBeInTheDocument()
  })
})
