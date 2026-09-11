import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { SearchResult } from '@aiper/shared/types'

const { mockSearchDocuments, mockSearchInProject } = vi.hoisted(() => ({
  mockSearchDocuments: vi.fn<
    (q: string, limit?: number, signal?: AbortSignal) => Promise<SearchResult[]>
  >(),
  mockSearchInProject: vi.fn<
    (
      pid: string,
      q: string,
      limit?: number,
      signal?: AbortSignal,
    ) => Promise<SearchResult[]>
  >(),
}))

vi.mock('../../src/api/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/endpoints')>(
    '../../src/api/endpoints',
  )
  return {
    ...actual,
    searchDocuments: mockSearchDocuments,
    searchInProject: mockSearchInProject,
  }
})

const { GlobalSearch } = await import('../../src/shell/GlobalSearch')

const PID = '00000000-0000-4000-8000-000000000001'
const FID = '00000000-0000-4000-8000-000000000010'
const DID1 = '00000000-0000-4000-8000-000000000100'
const DID2 = '00000000-0000-4000-8000-000000000101'

const RESULTS: SearchResult[] = [
  {
    document: { id: DID1, title: 'Mission profile', kind: 'authored' },
    project: { id: PID, name: 'Mars Orbiter' },
    folder: { id: FID, name: 'Requirements' },
    myRole: 'owner',
  },
  {
    // Project-parented: folder is null → nav should skip the /f/:fid segment.
    document: { id: DID2, title: 'Charter', kind: 'authored' },
    project: { id: PID, name: 'Mars Orbiter' },
    folder: null,
    myRole: 'editor',
  },
]

/** Renders the search inside a MemoryRouter at the given path so the
 *  component's `useParams()` observes `:pid` (or not). Also mounts a
 *  <LocationProbe/> so a nav can be asserted. */
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="path">{loc.pathname}</div>
}

function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <GlobalSearch />
              <LocationProbe />
            </>
          }
        />
        <Route
          path="/p/:pid"
          element={
            <>
              <GlobalSearch />
              <LocationProbe />
            </>
          }
        />
        <Route path="/p/:pid/d/:did" element={<LocationProbe />} />
        <Route path="/p/:pid/f/:fid/d/:did" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockSearchDocuments.mockReset().mockResolvedValue(RESULTS)
  mockSearchInProject.mockReset().mockResolvedValue(RESULTS)
})

describe('<GlobalSearch>', () => {
  it('does not fire the fetch immediately — debounce holds until the user pauses', async () => {
    const user = userEvent.setup()
    renderAt('/')
    await user.type(screen.getByRole('searchbox'), 'miss')

    // Immediately after typing, no fetch yet (debounce is 250ms).
    expect(mockSearchDocuments).not.toHaveBeenCalled()

    // The debounced fetch fires after ~250ms; waitFor polls up to its
    // default 1s window.
    await waitFor(() => {
      expect(mockSearchDocuments).toHaveBeenCalledTimes(1)
    })
    expect(mockSearchDocuments).toHaveBeenCalledWith(
      'miss',
      20,
      expect.any(AbortSignal),
    )
  })

  it('renders each result with title + breadcrumb', async () => {
    const user = userEvent.setup()
    renderAt('/')
    await user.type(screen.getByRole('searchbox'), 'x')

    expect(await screen.findByRole('option', { name: /Mission profile/i })).toBeInTheDocument()
    // Folder-parented result crumb includes folder name.
    expect(screen.getByText(/Mars Orbiter\s*\/\s*Requirements/)).toBeInTheDocument()
    // Project-parented result crumb (folder null) shows just the project.
    expect(screen.getByRole('option', { name: /Charter/i })).toBeInTheDocument()
  })

  it('navigates to /p/:pid/f/:fid/d/:did for a folder-parented hit', async () => {
    const user = userEvent.setup()
    renderAt('/')
    await user.type(screen.getByRole('searchbox'), 'x')

    await user.click(await screen.findByRole('option', { name: /Mission profile/i }))
    expect(screen.getByTestId('path')).toHaveTextContent(`/p/${PID}/f/${FID}/d/${DID1}`)
  })

  it('navigates to /p/:pid/d/:did for a project-parented hit (folder null)', async () => {
    const user = userEvent.setup()
    renderAt('/')
    await user.type(screen.getByRole('searchbox'), 'x')

    await user.click(await screen.findByRole('option', { name: /Charter/i }))
    expect(screen.getByTestId('path')).toHaveTextContent(`/p/${PID}/d/${DID2}`)
  })

  it('shows "No matches" when the server returns []', async () => {
    mockSearchDocuments.mockResolvedValue([])
    const user = userEvent.setup()
    renderAt('/')
    await user.type(screen.getByRole('searchbox'), 'zzz')

    expect(await screen.findByText(/no matches/i)).toBeInTheDocument()
  })

  it('uses searchInProject when the caller is on a /p/:pid route', async () => {
    const user = userEvent.setup()
    renderAt(`/p/${PID}`)
    await user.type(screen.getByRole('searchbox'), 'miss')

    await waitFor(() => {
      expect(mockSearchInProject).toHaveBeenCalledWith(
        PID,
        'miss',
        20,
        expect.any(AbortSignal),
      )
    })
    expect(mockSearchDocuments).not.toHaveBeenCalled()
  })

  it('collapses rapid typing into a single fetch for the final query', async () => {
    const user = userEvent.setup()
    renderAt('/')

    // userEvent.type awaits internally with a small delay per keystroke —
    // faster than 250ms, so all four keystrokes coalesce into one debounce
    // window. After a brief settle, only the final "miss" is fetched.
    await user.type(screen.getByRole('searchbox'), 'miss')

    await waitFor(() => {
      expect(mockSearchDocuments).toHaveBeenCalledTimes(1)
    })
    expect(mockSearchDocuments).toHaveBeenCalledWith(
      'miss',
      20,
      expect.any(AbortSignal),
    )
  })
})
