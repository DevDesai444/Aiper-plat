import { create } from 'zustand'
import { api, type ApiUser } from '../api/client'

interface SessionState {
  user: ApiUser | null
  status: 'unknown' | 'signed-out' | 'signed-in'
  error: string | null
  busy: boolean
  serverOnline: boolean
  presence: Array<{ userId: string; displayName: string }>

  restore: () => Promise<void>
  signInWithToken: (token: string) => Promise<void>
  signOut: () => Promise<void>
  setServerOnline: (online: boolean) => void
  setPresence: (userId: string, displayName: string, online: boolean) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  user: null,
  status: 'unknown',
  error: null,
  busy: false,
  serverOnline: false,
  presence: [],

  /**
   * Reuse the GitHub token kept from a previous session, so signing in is a once-per-machine
   * act rather than a once-per-launch one. The token is held by the main process, encrypted
   * with the OS keychain.
   */
  restore: async () => {
    const token = await window.aiper?.github?.storedToken().catch(() => null)
    if (!token) {
      set({ status: 'signed-out' })
      return
    }
    try {
      const user = await api.adoptToken(token)
      set({ user, status: 'signed-in', error: null })
    } catch {
      // Revoked, expired, or offline on first launch — back to the sign-in screen.
      await window.aiper?.github?.signOut().catch(() => undefined)
      set({ user: null, status: 'signed-out' })
    }
  },



  /** The device flow approved on github.com; adopt the token it produced. */
  signInWithToken: async (token) => {
    set({ busy: true, error: null })
    try {
      const user = await api.adoptToken(token)
      set({ user, status: 'signed-in', busy: false })
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : 'Could not read your GitHub account.' })
    }
  },

  signOut: async () => {
    await api.logout().catch(() => undefined)
    set({ user: null, status: 'signed-out', presence: [] })
  },

  setServerOnline: (serverOnline) => set({ serverOnline }),

  setPresence: (userId, displayName, online) =>
    set(() => {
      const others = get().presence.filter((p) => p.userId !== userId)
      // Never list yourself as "also editing" — it reads as a ghost session.
      const isSelf = get().user?.id === userId
      return { presence: online && !isSelf ? [...others, { userId, displayName }] : others }
    })
}))
