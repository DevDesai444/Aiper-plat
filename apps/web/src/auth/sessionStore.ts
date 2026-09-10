import { create } from 'zustand'
import type { SessionUser } from '@aiper/shared/types'
import { supabase } from './supabase'
import { getMe } from '../api/endpoints'

export type SessionStatus = 'unknown' | 'signed-out' | 'signed-in'

interface SessionState {
  /**
   * `unknown` covers the window between mount and the first
   * `supabase.auth.getSession()` result. Guards render a neutral loading
   * shell during it — redirecting on `unknown` would flash `/login` for
   * signed-in users on every page refresh.
   */
  status: SessionStatus
  user: SessionUser | null
  /** Surfaced by LoginPage; cleared by any subsequent action. */
  error: string | null
  /** True while an in-flight sign-in / sign-out is pending. */
  busy: boolean

  signInWithPassword: (email: string, password: string) => Promise<void>
  signUpWithPassword: (email: string, password: string) => Promise<void>
  signInWithMagicLink: (email: string) => Promise<void>
  signOut: () => Promise<void>
  /**
   * Wire the store to `supabase.auth.onAuthStateChange` and prime it with
   * the currently-restored session. Call once at app boot; the returned
   * function detaches the subscription.
   */
  initialize: () => () => void
}

async function hydrateFromSession(
  set: (partial: Partial<SessionState>) => void,
): Promise<void> {
  try {
    const user = await getMe()
    set({ status: 'signed-in', user, error: null })
  } catch (err) {
    // The Supabase token verified against JWKS but the server would not
    // hand us a SessionUser — treat as signed-out and drop the Supabase
    // session so we don't keep retrying on every navigation. Surfaces
    // through LoginPage so the operator sees why.
    await supabase.auth.signOut().catch(() => undefined)
    set({
      status: 'signed-out',
      user: null,
      error:
        err instanceof Error
          ? `Signed in with Supabase but the server rejected the session: ${err.message}`
          : 'Signed in with Supabase but the server rejected the session.',
    })
  }
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'unknown',
  user: null,
  error: null,
  busy: false,

  signInWithPassword: async (email, password) => {
    set({ busy: true, error: null })
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      set({ busy: false, error: error.message })
      return
    }
    // onAuthStateChange handles the rest — no need to set status here.
    set({ busy: false })
  },

  signUpWithPassword: async (email, password) => {
    set({ busy: true, error: null })
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) {
      set({ busy: false, error: error.message })
      return
    }
    // With `Enable email confirmations` OFF in Supabase Auth → Providers →
    // Email, `signUp` returns a session immediately and onAuthStateChange
    // fires with SIGNED_IN — the user is in without touching their inbox.
    // With confirmations ON, session is null and we surface a "check your
    // email" message; the user completes signup by clicking the link.
    if (!data.session) {
      set({
        busy: false,
        error:
          'Account created. Check your email to confirm before signing in ' +
          '— then come back and use "Sign in with a password".',
      })
      return
    }
    set({ busy: false })
  },

  signInWithMagicLink: async (email) => {
    set({ busy: true, error: null })
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/` },
    })
    set({ busy: false, error: error?.message ?? null })
  },

  signOut: async () => {
    set({ busy: true })
    await supabase.auth.signOut().catch(() => undefined)
    // onAuthStateChange will drop status to signed-out; clearing here too
    // means the UI does not lag one tick behind the click.
    set({ status: 'signed-out', user: null, busy: false, error: null })
  },

  initialize: () => {
    void supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        set({ status: 'signed-out', user: null })
        return
      }
      void hydrateFromSession(set)
    })

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        set({ status: 'signed-out', user: null })
        return
      }
      // SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED all re-hydrate — /me is
      // cheap and a refresh could carry updated org memberships.
      void hydrateFromSession(set)
    })

    return () => data.subscription.unsubscribe()
  },
}))
