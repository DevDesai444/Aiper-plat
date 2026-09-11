import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import * as Y from 'yjs'
import * as buffer from 'lib0/buffer'
import type { Document } from '@aiper/shared/types'
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

// Dynamic import after mock so the editor module resolves the mocked supabase.
const { EditorPage } = await import('../../src/editor/EditorPage')

const DID = '33333333-3333-4333-8333-333333333333'
const PID = '44444444-4444-4444-8444-444444444444'
const FID = '55555555-5555-4555-8555-555555555555'
const SID = '66666666-6666-4666-8666-666666666666'
const USER_ID = '11111111-1111-4111-8111-111111111111'

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

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="p/:pid/f/:fid/d/:did" element={<EditorPage />} />
        <Route path="p/:pid/d/:did" element={<EditorPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockSupabase.auth.getSession.mockReset()
  mockSupabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
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
})
