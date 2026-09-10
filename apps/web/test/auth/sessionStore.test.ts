import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../msw/server'
import { FAKE_USER_ID, FAKE_ORG_ID } from '../msw/handlers'

/**
 * Shape of the argument Supabase passes to onAuthStateChange callbacks.
 * We only care about a couple of fields — session may be null (signed out).
 */
type SupabaseSession = { access_token: string; user: { id: string } } | null
type AuthCallback = (event: string, session: SupabaseSession) => void

const { mockSupabase, callbackRef } = vi.hoisted(() => {
  const callbackRef: { current: AuthCallback | null } = { current: null }
  return {
    callbackRef,
    mockSupabase: {
      auth: {
        getSession: vi.fn<() => Promise<{ data: { session: SupabaseSession } }>>(),
        onAuthStateChange: vi.fn((cb: AuthCallback) => {
          callbackRef.current = cb
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        }),
        signInWithPassword: vi.fn(),
        signInWithOtp: vi.fn(),
        signOut: vi.fn(async () => ({ error: null })),
      },
    },
  }
})

vi.mock('../../src/auth/supabase', () => ({ supabase: mockSupabase }))

const { useSessionStore } = await import('../../src/auth/sessionStore')

const FAKE_SESSION = {
  access_token: 'supa-token',
  user: { id: FAKE_USER_ID },
}

beforeEach(() => {
  // Zustand stores are singletons — reset the data fields between tests so
  // one test's SIGNED_IN doesn't bleed into the next.
  useSessionStore.setState({
    status: 'unknown',
    user: null,
    error: null,
    busy: false,
  })
  callbackRef.current = null
  mockSupabase.auth.getSession.mockReset()
  mockSupabase.auth.signOut.mockClear()
})

describe('useSessionStore', () => {
  it('starts in status: unknown', () => {
    expect(useSessionStore.getState().status).toBe('unknown')
  })

  it('initialize with no restored session → signed-out', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } })

    useSessionStore.getState().initialize()

    await vi.waitFor(() => expect(useSessionStore.getState().status).toBe('signed-out'))
    expect(useSessionStore.getState().user).toBeNull()
  })

  it('initialize with a restored session hydrates SessionUser from /me → signed-in', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: FAKE_SESSION } })

    useSessionStore.getState().initialize()

    await vi.waitFor(() => expect(useSessionStore.getState().status).toBe('signed-in'))
    const user = useSessionStore.getState().user
    expect(user?.id).toBe(FAKE_USER_ID)
    expect(user?.email).toBe('alice@example.com')
    expect(user?.orgMemberships).toEqual([{ orgId: FAKE_ORG_ID, role: 'admin' }])
  })

  it('a subsequent SIGNED_OUT event clears the user', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: FAKE_SESSION } })
    useSessionStore.getState().initialize()
    await vi.waitFor(() => expect(useSessionStore.getState().status).toBe('signed-in'))

    callbackRef.current?.('SIGNED_OUT', null)
    expect(useSessionStore.getState().status).toBe('signed-out')
    expect(useSessionStore.getState().user).toBeNull()
  })

  it('a failed /me hydration signs out and surfaces the error', async () => {
    server.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json({ error: 'Provisioning failed', code: 'prov_err' }, { status: 500 }),
      ),
    )
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: FAKE_SESSION } })

    useSessionStore.getState().initialize()

    await vi.waitFor(() => expect(useSessionStore.getState().status).toBe('signed-out'))
    expect(useSessionStore.getState().error).toContain('Provisioning failed')
    expect(mockSupabase.auth.signOut).toHaveBeenCalled()
  })

  it('signOut clears state and calls supabase.auth.signOut', async () => {
    useSessionStore.setState({
      status: 'signed-in',
      user: {
        id: FAKE_USER_ID,
        email: 'a@b.co',
        displayName: 'X',
        avatarUrl: null,
        orgMemberships: [],
      },
    })

    await useSessionStore.getState().signOut()

    expect(mockSupabase.auth.signOut).toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('signed-out')
    expect(useSessionStore.getState().user).toBeNull()
  })
})
