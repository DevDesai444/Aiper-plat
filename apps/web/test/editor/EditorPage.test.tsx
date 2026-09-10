import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import * as Y from 'yjs'
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
})
