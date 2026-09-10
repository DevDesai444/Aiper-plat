import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { useSessionStore } from './auth/sessionStore'

export default function App() {
  // Install the Supabase onAuthStateChange subscription exactly once.
  // Under StrictMode this runs twice in dev; the returned cleanup unsubscribes
  // the first attach so we never leak a listener.
  useEffect(() => {
    return useSessionStore.getState().initialize()
  }, [])

  return <RouterProvider router={router} />
}
