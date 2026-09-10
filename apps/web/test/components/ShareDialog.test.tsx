import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Invitation, Member } from '../../src/api/access'

const {
  mockListMembers,
  mockListInvitations,
  mockGrantPermission,
  mockRevokePermission,
  mockSendInvitation,
  mockRevokeInvitation,
} = vi.hoisted(() => ({
  mockListMembers: vi.fn(),
  mockListInvitations: vi.fn(),
  mockGrantPermission: vi.fn(),
  mockRevokePermission: vi.fn(),
  mockSendInvitation: vi.fn(),
  mockRevokeInvitation: vi.fn(),
}))

vi.mock('../../src/api/access', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/access')>(
    '../../src/api/access',
  )
  return {
    ...actual,
    listMembers: mockListMembers,
    listInvitations: mockListInvitations,
    grantPermission: mockGrantPermission,
    revokePermission: mockRevokePermission,
    sendInvitation: mockSendInvitation,
    revokeInvitation: mockRevokeInvitation,
  }
})

const { ShareDialog } = await import('../../src/components/ShareDialog')
const { ApiFetchError } = await import('../../src/api/client')

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const OWNER_USER_ID = '00000000-0000-4000-8000-000000000010'
const EDITOR_USER_ID = '00000000-0000-4000-8000-000000000011'
const PARENT_PROJECT_ID = '00000000-0000-4000-8000-000000000002'

const MEMBERS: Member[] = [
  {
    userId: OWNER_USER_ID,
    displayName: 'Alice Owner',
    email: 'alice@example.com',
    role: 'owner',
    inherited: false,
  },
  {
    userId: EDITOR_USER_ID,
    displayName: 'Bob Editor',
    email: 'bob@example.com',
    role: 'editor',
    inherited: true,
    source: { subjectType: 'project', subjectId: PARENT_PROJECT_ID },
  },
]

const INVITATIONS: Invitation[] = [
  {
    email: 'carol@example.com',
    role: 'viewer',
    invitedAt: '2026-09-01T12:00:00.000Z',
    invitedByName: 'Alice Owner',
  },
]

beforeEach(() => {
  mockListMembers.mockReset().mockResolvedValue(MEMBERS)
  mockListInvitations.mockReset().mockResolvedValue(INVITATIONS)
  mockGrantPermission.mockReset().mockResolvedValue({
    subjectType: 'project',
    subjectId: PROJECT_ID,
    userId: OWNER_USER_ID,
    role: 'owner',
  })
  mockRevokePermission.mockReset().mockResolvedValue(undefined)
  mockSendInvitation.mockReset().mockResolvedValue({
    subjectType: 'project',
    subjectId: PROJECT_ID,
    role: 'viewer',
    immediate: false,
    email: 'dave@example.com',
  })
  mockRevokeInvitation.mockReset().mockResolvedValue(undefined)
})

function renderDialog(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  return render(
    <ShareDialog
      subjectType="project"
      subjectId={PROJECT_ID}
      subjectLabel="Mars Orbiter"
      callerRole={role}
      onClose={() => undefined}
    />,
  )
}

describe('<ShareDialog>', () => {
  it('renders members + inherited tag + pending invites for an owner', async () => {
    renderDialog('owner')
    expect(await screen.findByText('Alice Owner')).toBeInTheDocument()
    expect(screen.getByText('Bob Editor')).toBeInTheDocument()
    // Inherited tag on the editor row
    expect(screen.getByText('Inherited')).toBeInTheDocument()
    // Pending invite
    expect(screen.getByText('carol@example.com')).toBeInTheDocument()
    // Owner-only invite form present
    expect(screen.getByPlaceholderText(/name@example\.com/i)).toBeInTheDocument()
  })

  it('hides the invite form and remove/revoke controls for a viewer', async () => {
    renderDialog('viewer')
    expect(await screen.findByText('Alice Owner')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/name@example\.com/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('POSTs a role change and refetches', async () => {
    const user = userEvent.setup()
    renderDialog('owner')
    await screen.findByText('Alice Owner')

    // The direct-owner row's role dropdown starts on 'owner'. Change it.
    const [ownerSelect] = screen.getAllByRole('combobox')
    if (!ownerSelect) throw new Error('expected role dropdown')
    await user.selectOptions(ownerSelect, 'editor')

    await waitFor(() => {
      expect(mockGrantPermission).toHaveBeenCalledWith(
        'project',
        PROJECT_ID,
        OWNER_USER_ID,
        'editor',
      )
    })
    // Refetch fires: listMembers + listInvitations called at least twice
    // total (initial + post-mutation).
    expect(mockListMembers.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('surfaces 409 last_owner inline on the row that tried to change', async () => {
    const user = userEvent.setup()
    mockRevokePermission.mockRejectedValueOnce(
      new ApiFetchError('This is the only owner. Add another owner first.', 409, {
        error: 'This is the only owner. Add another owner first.',
        code: 'last_owner',
      }),
    )
    renderDialog('owner')
    await screen.findByText('Alice Owner')

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons).toHaveLength(1)
    await user.click(removeButtons[0]!)

    expect(await screen.findByText(/only owner/i)).toBeInTheDocument()
    // No refetch on failure — mutation path threw before reaching refetch
    expect(mockListMembers).toHaveBeenCalledTimes(1)
  })

  it('sends an invitation and refetches', async () => {
    const user = userEvent.setup()
    renderDialog('owner')
    await screen.findByText('Alice Owner')

    const emailInput = screen.getByPlaceholderText(/name@example\.com/i)
    await user.type(emailInput, 'dave@example.com')
    await user.click(screen.getByRole('button', { name: /invite/i }))

    await waitFor(() => {
      expect(mockSendInvitation).toHaveBeenCalledWith(
        'project',
        PROJECT_ID,
        'dave@example.com',
        'editor', // default role in the invite form
      )
    })
    expect(mockListInvitations.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('revokes a pending invitation', async () => {
    const user = userEvent.setup()
    renderDialog('owner')
    await screen.findByText('carol@example.com')

    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => {
      expect(mockRevokeInvitation).toHaveBeenCalledWith(
        'project',
        PROJECT_ID,
        'carol@example.com',
      )
    })
  })

  it('surfaces a load error when the members read fails (E2 endpoint not yet live)', async () => {
    mockListMembers.mockRejectedValueOnce(
      new ApiFetchError('Not Found', 404, { error: 'Not Found', code: 'not_found' }),
    )
    renderDialog('owner')
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })
})
