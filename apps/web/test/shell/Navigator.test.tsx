import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ProjectFolderTree } from '@aiper/shared/types'

const { mockGetProjectFolderTree } = vi.hoisted(() => ({
  mockGetProjectFolderTree: vi.fn<(pid: string) => Promise<ProjectFolderTree>>(),
}))

vi.mock('../../src/api/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/endpoints')>(
    '../../src/api/endpoints',
  )
  return { ...actual, getProjectFolderTree: mockGetProjectFolderTree }
})

const { Navigator } = await import('../../src/shell/Navigator')
const { useUiStore } = await import('../../src/shell/uiStore')

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const FOLDER_ROOT_ID = '00000000-0000-4000-8000-000000000010'
const FOLDER_CHILD_ID = '00000000-0000-4000-8000-000000000011'
const DOC_ID = '00000000-0000-4000-8000-000000000100'

const TREE: ProjectFolderTree = {
  project: {
    id: PROJECT_ID,
    orgId: '00000000-0000-4000-8000-000000000002',
    name: 'Mars Orbiter',
    slug: 'mars-orbiter',
    createdBy: '00000000-0000-4000-8000-000000000003',
    createdAt: '2026-01-01T00:00:00.000Z',
    myRole: 'editor',
  },
  folders: [
    {
      folder: {
        id: FOLDER_ROOT_ID,
        projectId: PROJECT_ID,
        parentFolderId: null,
        name: 'Requirements',
        createdBy: '00000000-0000-4000-8000-000000000003',
        createdAt: '2026-01-01T00:00:00.000Z',
        myRole: 'editor',
      },
      children: [{ id: FOLDER_CHILD_ID, name: 'Thermal' }],
      documents: [{ id: DOC_ID, title: 'Mission profile', kind: 'authored' }],
    },
    {
      folder: {
        id: FOLDER_CHILD_ID,
        projectId: PROJECT_ID,
        parentFolderId: FOLDER_ROOT_ID,
        name: 'Thermal',
        createdBy: '00000000-0000-4000-8000-000000000003',
        createdAt: '2026-01-01T00:00:00.000Z',
        myRole: 'editor',
      },
      children: [],
      documents: [],
    },
  ],
}

function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<Navigator />} />
        <Route path="/p/:pid" element={<Navigator />} />
        <Route path="/p/:pid/f/:fid" element={<Navigator />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockGetProjectFolderTree.mockReset()
  useUiStore.setState({ leftOpen: true, navFilter: '' })
})

describe('<Navigator>', () => {
  it('shows an empty state outside a project context', () => {
    renderAt('/')
    expect(screen.getByText(/open a project/i)).toBeInTheDocument()
    expect(mockGetProjectFolderTree).not.toHaveBeenCalled()
  })

  it('fetches the folder tree on mount when :pid is in the URL', async () => {
    mockGetProjectFolderTree.mockResolvedValue(TREE)
    renderAt(`/p/${PROJECT_ID}`)

    await waitFor(() => {
      expect(mockGetProjectFolderTree).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.any(AbortSignal),
      )
    })
    expect(await screen.findByText('Requirements')).toBeInTheDocument()
    expect(screen.getByText('Thermal')).toBeInTheDocument()
    expect(screen.getByText('Mission profile')).toBeInTheDocument()
  })

  it('renders a "no folders" empty state for a project with an empty tree', async () => {
    mockGetProjectFolderTree.mockResolvedValue({ ...TREE, folders: [] })
    renderAt(`/p/${PROJECT_ID}`)
    expect(await screen.findByText(/no folders in this project/i)).toBeInTheDocument()
  })

  it('narrows the tree via the filter input', async () => {
    mockGetProjectFolderTree.mockResolvedValue(TREE)
    renderAt(`/p/${PROJECT_ID}`)
    // Wait for the tree to be populated before typing.
    await screen.findByText('Requirements')

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/filter files/i), 'thermal')

    // "Thermal" folder survives; "Requirements" (which does not match its
    // own name and whose only doc "Mission profile" also does not match)
    // is filtered out.
    await waitFor(() => {
      expect(screen.queryByText('Requirements')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Thermal')).toBeInTheDocument()
  })

  it('renders "no folders" collapsed variant when leftOpen is false', () => {
    useUiStore.setState({ leftOpen: false })
    renderAt(`/p/${PROJECT_ID}`)
    expect(screen.getByText('Navigator')).toBeInTheDocument()
    expect(mockGetProjectFolderTree).not.toHaveBeenCalled()
  })
})
