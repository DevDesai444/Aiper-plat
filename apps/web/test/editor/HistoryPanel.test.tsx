import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DocumentSnapshot } from '@aiper/shared/types'

const { mockGetDocumentHistory } = vi.hoisted(() => ({
  mockGetDocumentHistory: vi.fn<(did: string) => Promise<DocumentSnapshot[]>>(),
}))

vi.mock('../../src/api/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/endpoints')>(
    '../../src/api/endpoints',
  )
  return { ...actual, getDocumentHistory: mockGetDocumentHistory }
})

// The panel labels rows by the current session user's id (renders "You" for
// self-authored saves). Mock the store's data fields directly.
vi.mock('../../src/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(),
      signOut: vi.fn(),
    },
  },
}))

const { HistoryPanel } = await import('../../src/editor/HistoryPanel')
const { useSessionStore } = await import('../../src/auth/sessionStore')

const DOC_ID = '00000000-0000-4000-8000-000000000001'
const ME_USER_ID = '00000000-0000-4000-8000-000000000010'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000011'
const SNAP_1 = '00000000-0000-4000-8000-000000000100'
const SNAP_2 = '00000000-0000-4000-8000-000000000101'

const TIMELINE: DocumentSnapshot[] = [
  // Newest first — the server sorts by saved_at DESC.
  {
    id: SNAP_1,
    documentId: DOC_ID,
    savedBy: ME_USER_ID,
    savedAt: '2026-09-11T15:00:00.000Z',
    reason: 'checkpoint',
    label: 'Signed off by lead',
  },
  {
    id: SNAP_2,
    documentId: DOC_ID,
    savedBy: OTHER_USER_ID,
    savedAt: '2026-09-10T12:30:00.000Z',
    reason: 'auto',
    label: null,
  },
]

beforeEach(() => {
  mockGetDocumentHistory.mockReset().mockResolvedValue(TIMELINE)
  useSessionStore.setState({
    status: 'signed-in',
    user: {
      id: ME_USER_ID,
      email: 'me@example.com',
      displayName: 'Alice',
      avatarUrl: null,
      orgMemberships: [],
    },
    error: null,
    busy: false,
  })
})

describe('<HistoryPanel>', () => {
  it('starts closed — only the toggle FAB is visible; no fetch fires', () => {
    render(<HistoryPanel documentId={DOC_ID} />)
    expect(screen.getByRole('button', { name: /open save history/i })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: /save history/i })).not.toBeInTheDocument()
    expect(mockGetDocumentHistory).not.toHaveBeenCalled()
  })

  it('opens the drawer on FAB click and fetches the timeline', async () => {
    const user = userEvent.setup()
    render(<HistoryPanel documentId={DOC_ID} />)

    await user.click(screen.getByRole('button', { name: /open save history/i }))

    await waitFor(() => {
      expect(mockGetDocumentHistory).toHaveBeenCalledWith(DOC_ID, expect.any(AbortSignal))
    })
    expect(await screen.findByRole('complementary', { name: /save history/i })).toBeInTheDocument()
  })

  it('renders snapshots in the order returned (newest first) and marks self as "You"', async () => {
    const user = userEvent.setup()
    render(<HistoryPanel documentId={DOC_ID} />)
    await user.click(screen.getByRole('button', { name: /open save history/i }))

    // The row for SNAP_1 (saved by ME_USER_ID) shows "You".
    expect(await screen.findByText('You')).toBeInTheDocument()
    // Label + reason chip present
    expect(screen.getByText('Signed off by lead')).toBeInTheDocument()
    expect(screen.getByText('checkpoint')).toBeInTheDocument()
    expect(screen.getByText('auto')).toBeInTheDocument()

    // Ordering: SNAP_1's list item precedes SNAP_2's in DOM order.
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('You')
    expect(items[1]!.textContent).toContain('u:00000000') // OTHER_USER_ID short prefix
  })

  it('shows the empty state when the server returns no snapshots', async () => {
    mockGetDocumentHistory.mockResolvedValue([])
    const user = userEvent.setup()
    render(<HistoryPanel documentId={DOC_ID} />)
    await user.click(screen.getByRole('button', { name: /open save history/i }))
    expect(await screen.findByText(/no saves yet/i)).toBeInTheDocument()
  })

  it('surfaces a load error and offers Retry', async () => {
    mockGetDocumentHistory
      .mockRejectedValueOnce(new Error('network is down'))
      .mockResolvedValueOnce(TIMELINE)

    const user = userEvent.setup()
    render(<HistoryPanel documentId={DOC_ID} />)
    await user.click(screen.getByRole('button', { name: /open save history/i }))

    expect(await screen.findByText(/network is down/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))

    // On retry the timeline renders.
    expect(await screen.findByText('You')).toBeInTheDocument()
    expect(mockGetDocumentHistory).toHaveBeenCalledTimes(2)
  })

  it('closes the drawer via the header close button', async () => {
    const user = userEvent.setup()
    render(<HistoryPanel documentId={DOC_ID} />)
    await user.click(screen.getByRole('button', { name: /open save history/i }))
    await screen.findByText('You')

    await user.click(screen.getByRole('button', { name: /close save history/i }))
    expect(screen.queryByRole('complementary', { name: /save history/i })).not.toBeInTheDocument()
    // FAB is back
    expect(screen.getByRole('button', { name: /open save history/i })).toBeInTheDocument()
  })
})
