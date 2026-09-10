import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

// Mock supabase so importing sessionStore doesn't drag in a live client.
vi.mock('../../src/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
    },
  },
}))

const { RequireSession } = await import('../../src/router/RequireSession')
const { useSessionStore } = await import('../../src/auth/sessionStore')

/** Renders /pathname (or the state that a redirect landed at) as visible text
 *  so the test can assert on the guard's redirect behaviour. */
function LocationProbe() {
  const loc = useLocation()
  return (
    <div>
      <span data-testid="path">{loc.pathname}</span>
      <span data-testid="from">
        {(loc.state as { from?: string } | null)?.from ?? ''}
      </span>
    </div>
  )
}

function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/"
          element={
            <RequireSession>
              <div>secret content</div>
            </RequireSession>
          }
        />
        <Route
          path="/p/:pid"
          element={
            <RequireSession>
              <div>project content</div>
            </RequireSession>
          }
        />
        <Route path="/login" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useSessionStore.setState({
    status: 'unknown',
    user: null,
    error: null,
    busy: false,
  })
})

describe('<RequireSession>', () => {
  it('shows a loading pane while status is unknown', () => {
    renderAt('/')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
  })

  it('redirects to /login when signed-out, preserving the intended path', () => {
    useSessionStore.setState({ status: 'signed-out' })
    renderAt('/p/proj-42')
    expect(screen.getByTestId('path')).toHaveTextContent('/login')
    expect(screen.getByTestId('from')).toHaveTextContent('/p/proj-42')
  })

  it('renders children when signed-in', () => {
    useSessionStore.setState({ status: 'signed-in' })
    renderAt('/')
    expect(screen.getByText('secret content')).toBeInTheDocument()
  })
})
