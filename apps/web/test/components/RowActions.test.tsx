import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProjectFolderTree } from '@aiper/shared/types'

const {
  mockRenameDocument,
  mockRenameFolder,
  mockDeleteDocument,
  mockDeleteFolder,
  mockMoveDocument,
  mockMoveFolder,
  mockGetProjectFolderTree,
} = vi.hoisted(() => ({
  mockRenameDocument: vi.fn(),
  mockRenameFolder: vi.fn(),
  mockDeleteDocument: vi.fn(),
  mockDeleteFolder: vi.fn(),
  mockMoveDocument: vi.fn(),
  mockMoveFolder: vi.fn(),
  mockGetProjectFolderTree: vi.fn<
    (pid: string) => Promise<ProjectFolderTree>
  >(),
}))

vi.mock('../../src/api/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/endpoints')>(
    '../../src/api/endpoints',
  )
  return {
    ...actual,
    renameDocument: mockRenameDocument,
    renameFolder: mockRenameFolder,
    deleteDocument: mockDeleteDocument,
    deleteFolder: mockDeleteFolder,
    moveDocument: mockMoveDocument,
    moveFolder: mockMoveFolder,
    getProjectFolderTree: mockGetProjectFolderTree,
  }
})

const { RowActions } = await import('../../src/components/RowActions')

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const DOC_ID = '00000000-0000-4000-8000-000000000010'
const FOLDER_ID = '00000000-0000-4000-8000-000000000020'
const OTHER_FOLDER_ID = '00000000-0000-4000-8000-000000000021'

const TREE: ProjectFolderTree = {
  project: {
    id: PROJECT_ID,
    orgId: '00000000-0000-4000-8000-000000000002',
    name: 'Mars Orbiter',
    slug: 'mars-orbiter',
    createdBy: '00000000-0000-4000-8000-000000000003',
    createdAt: '2026-01-01T00:00:00.000Z',
    myRole: 'owner',
  },
  folders: [
    {
      folder: {
        id: FOLDER_ID,
        projectId: PROJECT_ID,
        parentFolderId: null,
        name: 'Requirements',
        createdBy: '00000000-0000-4000-8000-000000000003',
        createdAt: '2026-01-01T00:00:00.000Z',
        myRole: 'owner',
      },
      children: [],
      documents: [],
    },
    {
      folder: {
        id: OTHER_FOLDER_ID,
        projectId: PROJECT_ID,
        parentFolderId: null,
        name: 'Thermal',
        createdBy: '00000000-0000-4000-8000-000000000003',
        createdAt: '2026-01-01T00:00:00.000Z',
        myRole: 'owner',
      },
      children: [],
      documents: [],
    },
  ],
}

beforeEach(() => {
  mockRenameDocument.mockReset().mockResolvedValue({ id: DOC_ID, title: 'x' })
  mockRenameFolder.mockReset().mockResolvedValue({ id: FOLDER_ID, name: 'x' })
  mockDeleteDocument.mockReset().mockResolvedValue(undefined)
  mockDeleteFolder.mockReset().mockResolvedValue(undefined)
  mockMoveDocument.mockReset().mockResolvedValue({ id: DOC_ID })
  mockMoveFolder.mockReset().mockResolvedValue({ id: FOLDER_ID })
  mockGetProjectFolderTree.mockReset().mockResolvedValue(TREE)
})

describe('<RowActions> role gates', () => {
  it('owner sees Rename + Move + Delete', async () => {
    const user = userEvent.setup()
    render(
      <RowActions
        subjectType="document"
        subjectId={DOC_ID}
        subjectLabel="Mission profile"
        role="owner"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'folder', folderId: FOLDER_ID }}
        onChanged={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Move…' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('editor sees only Rename (move + delete are owner-only)', async () => {
    const user = userEvent.setup()
    render(
      <RowActions
        subjectType="document"
        subjectId={DOC_ID}
        subjectLabel="Mission profile"
        role="editor"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'folder', folderId: FOLDER_ID }}
        onChanged={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Move…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('viewer sees no menu at all (button omitted, no menu to open)', () => {
    render(
      <RowActions
        subjectType="document"
        subjectId={DOC_ID}
        subjectLabel="Mission profile"
        role="viewer"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'folder', folderId: FOLDER_ID }}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /actions for/i })).not.toBeInTheDocument()
  })
})

describe('<RowActions> mutations', () => {
  it('rename dispatches renameFolder + fires onChanged', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(
      <RowActions
        subjectType="folder"
        subjectId={FOLDER_ID}
        subjectLabel="Requirements"
        role="owner"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'root' }}
        onChanged={onChanged}
      />,
    )

    await user.click(screen.getByRole('button', { name: /actions for/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))

    const input = await screen.findByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Requirements v2')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(mockRenameFolder).toHaveBeenCalledWith(FOLDER_ID, 'Requirements v2')
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('rename dispatches renameDocument for a document', async () => {
    const user = userEvent.setup()
    render(
      <RowActions
        subjectType="document"
        subjectId={DOC_ID}
        subjectLabel="Mission profile"
        role="editor"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'folder', folderId: FOLDER_ID }}
        onChanged={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Mission profile v2')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(mockRenameDocument).toHaveBeenCalledWith(DOC_ID, 'Mission profile v2')
    })
  })

  it('delete opens a confirm; Cancel does NOT dispatch', async () => {
    const user = userEvent.setup()
    render(
      <RowActions
        subjectType="document"
        subjectId={DOC_ID}
        subjectLabel="Mission profile"
        role="owner"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'folder', folderId: FOLDER_ID }}
        onChanged={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(mockDeleteDocument).not.toHaveBeenCalled()
  })

  it('delete confirm dispatches deleteDocument and fires onChanged', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(
      <RowActions
        subjectType="document"
        subjectId={DOC_ID}
        subjectLabel="Mission profile"
        role="owner"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'folder', folderId: FOLDER_ID }}
        onChanged={onChanged}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: /delete document/i }))

    await waitFor(() => {
      expect(mockDeleteDocument).toHaveBeenCalledWith(DOC_ID)
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('delete confirm on a folder dispatches deleteFolder with the folder-cascade warning', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(
      <RowActions
        subjectType="folder"
        subjectId={FOLDER_ID}
        subjectLabel="Requirements"
        role="owner"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'root' }}
        onChanged={onChanged}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))

    // Folder message warns about cascade
    expect(await screen.findByText(/every folder, document, and comment/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /delete folder/i }))

    await waitFor(() => {
      expect(mockDeleteFolder).toHaveBeenCalledWith(FOLDER_ID)
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('move opens picker + moveFolder receives parentFolderId', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(
      <RowActions
        subjectType="folder"
        subjectId={FOLDER_ID}
        subjectLabel="Requirements"
        role="owner"
        projectId={PROJECT_ID}
        currentParent={{ kind: 'root' }}
        onChanged={onChanged}
      />,
    )
    await user.click(screen.getByRole('button', { name: /actions for/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Move…' }))

    // Wait for the folder tree fetch to populate the picker.
    const target = await screen.findByRole('button', { name: /Thermal/ })
    await user.click(target)

    await waitFor(() => {
      expect(mockMoveFolder).toHaveBeenCalledWith(FOLDER_ID, OTHER_FOLDER_ID)
    })
    expect(onChanged).toHaveBeenCalled()
  })
})
