import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuditPage } from '@aiper/shared/types'

const { mockGetAuditPage } = vi.hoisted(() => ({
  mockGetAuditPage: vi.fn<
    (filters: {
      subjectType?: 'project' | 'folder' | 'document'
      subjectId?: string
      cursor?: string
      limit?: number
    }) => Promise<AuditPage>
  >(),
}))

vi.mock('../../src/api/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/endpoints')>(
    '../../src/api/endpoints',
  )
  return { ...actual, getAuditPage: mockGetAuditPage }
})

const { ActivityPanel } = await import('../../src/components/ActivityPanel')
const { labelForAction } = await import('../../src/components/actionLabels')

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const DOC_ID = '00000000-0000-4000-8000-000000000010'
const USER_ID = '00000000-0000-4000-8000-000000000020'

const PAGE_ONE: AuditPage = {
  entries: [
    {
      id: 101,
      occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      userId: USER_ID,
      printedName: 'Alice',
      action: 'document.renamed',
      subjectType: 'document',
      subjectId: DOC_ID,
      reason: 'clarify scope',
    },
    {
      id: 100,
      occurredAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      userId: USER_ID,
      printedName: 'Bob',
      action: 'product-node.linked',
      subjectType: 'project',
      subjectId: PROJECT_ID,
    },
  ],
  nextCursor: 'CURSOR_ONE',
}

const PAGE_TWO: AuditPage = {
  entries: [
    {
      id: 99,
      occurredAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      userId: USER_ID,
      printedName: 'Carol',
      action: 'folder.created',
      subjectType: 'folder',
      subjectId: '00000000-0000-4000-8000-000000000030',
    },
  ],
  nextCursor: null,
}

beforeEach(() => {
  mockGetAuditPage.mockReset()
})

describe('<ActivityPanel>', () => {
  it('fetches on mount and renders each entry with actor + human label', async () => {
    mockGetAuditPage.mockResolvedValue(PAGE_ONE)
    render(<ActivityPanel projectId={PROJECT_ID} />)

    // First call is scoped to the project with the initial page size.
    await waitFor(() => {
      expect(mockGetAuditPage).toHaveBeenCalledWith(
        { subjectType: 'project', subjectId: PROJECT_ID, limit: 25 },
        expect.any(AbortSignal),
      )
    })

    // Actors show as bold, labels as verb phrases, reasons carried through.
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('renamed a document')).toBeInTheDocument()
    expect(screen.getByText(/clarify scope/)).toBeInTheDocument()

    // The unknown-code fallback formats "product-node.linked" nicely.
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('linked a product-tree node to a document')).toBeInTheDocument()
  })

  it('Load more fetches the next page with the cursor and appends entries', async () => {
    mockGetAuditPage
      .mockResolvedValueOnce(PAGE_ONE)
      .mockResolvedValueOnce(PAGE_TWO)

    render(<ActivityPanel projectId={PROJECT_ID} />)
    await screen.findByText('Alice')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /load more/i }))

    await waitFor(() => {
      expect(mockGetAuditPage).toHaveBeenNthCalledWith(2, {
        subjectType: 'project',
        subjectId: PROJECT_ID,
        limit: 25,
        cursor: 'CURSOR_ONE',
      })
    })

    // Both pages' entries are visible now.
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Carol')).toBeInTheDocument()
    expect(screen.getByText('created a folder')).toBeInTheDocument()

    // Page 2's nextCursor is null → Load more hides.
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  it('shows the empty state when the server returns no entries', async () => {
    mockGetAuditPage.mockResolvedValue({ entries: [], nextCursor: null })
    render(<ActivityPanel projectId={PROJECT_ID} />)
    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument()
    // No Load more button
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  it('surfaces a load error with a Retry that re-fetches', async () => {
    mockGetAuditPage
      .mockRejectedValueOnce(new Error('network is down'))
      .mockResolvedValueOnce(PAGE_ONE)

    render(<ActivityPanel projectId={PROJECT_ID} />)
    expect(await screen.findByText(/network is down/i)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /retry/i }))

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(mockGetAuditPage).toHaveBeenCalledTimes(2)
  })
})

describe('labelForAction', () => {
  it('maps known codes to their curated labels', () => {
    expect(labelForAction('document.renamed')).toBe('renamed a document')
    expect(labelForAction('folder.deleted')).toBe('deleted a folder')
    expect(labelForAction('permission.granted')).toBe('granted access')
    expect(labelForAction('product-node.created')).toBe('added a product-tree node')
  })

  it('humanises unknown codes into a plain-english fallback', () => {
    expect(labelForAction('widget.frobnicated')).toBe('frobnicated a widget')
    expect(labelForAction('multi-word.exported')).toBe('exported a multi word')
  })

  it('does not throw on an oddly-shaped code (no dot)', () => {
    expect(labelForAction('legacy_event')).toBe('legacy event')
  })
})
