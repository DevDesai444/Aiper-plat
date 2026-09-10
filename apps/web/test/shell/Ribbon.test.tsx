import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockRunRibbonAction } = vi.hoisted(() => ({
  mockRunRibbonAction: vi.fn<(act: string) => void>(),
}))

vi.mock('../../src/shell/ribbon/actions', () => ({
  runRibbonAction: mockRunRibbonAction,
}))

const { Ribbon } = await import('../../src/shell/Ribbon')
const { useUiStore } = await import('../../src/shell/uiStore')

beforeEach(() => {
  mockRunRibbonAction.mockReset()
  useUiStore.setState({
    ribbonOpen: true,
    activeRibbonTab: 'Home',
    navFilter: '',
  })
})

describe('<Ribbon>', () => {
  it('renders groups for the active tab', () => {
    render(<Ribbon />)
    // Home tab groups
    expect(screen.getByText('CLIPBOARD')).toBeInTheDocument()
    expect(screen.getByText('FONT')).toBeInTheDocument()
    expect(screen.getByText('PARAGRAPH')).toBeInTheDocument()
    expect(screen.getByText('STYLES')).toBeInTheDocument()
  })

  it('renders nothing when ribbonOpen is false', () => {
    useUiStore.setState({ ribbonOpen: false })
    const { container } = render(<Ribbon />)
    expect(container.firstChild).toBeNull()
  })

  it('switches groups when activeRibbonTab changes', () => {
    render(<Ribbon />)
    expect(screen.getByText('CLIPBOARD')).toBeInTheDocument()
    cleanup()

    useUiStore.setState({ activeRibbonTab: 'References' })
    render(<Ribbon />)
    expect(screen.getByText('TABLE OF CONTENTS')).toBeInTheDocument()
    expect(screen.queryByText('CLIPBOARD')).not.toBeInTheDocument()
  })

  it('dispatches runRibbonAction with the button act on click', async () => {
    const user = userEvent.setup()
    render(<Ribbon />)

    // Paste is the Home tab's big button; act is edit.paste.
    await user.click(screen.getByRole('button', { name: 'Paste' }))
    expect(mockRunRibbonAction).toHaveBeenCalledWith('edit.paste')
  })

  it('dispatches from a glyph button (mark.bold)', async () => {
    const user = userEvent.setup()
    render(<Ribbon />)

    // Bold glyph shows literal "B".
    await user.click(screen.getByRole('button', { name: 'B' }))
    expect(mockRunRibbonAction).toHaveBeenCalledWith('mark.bold')
  })
})
