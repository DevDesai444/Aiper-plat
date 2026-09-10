import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Fail loudly at boot rather than at first auth call — a missing env is a
  // deployment mistake, not a runtime edge case.
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. ' +
      'Copy apps/web/.env.example to apps/web/.env and restart the dev server.',
  )
}

/**
 * Singleton Supabase client. Owns the JWT (persisted in localStorage as
 * `sb-<ref>-auth-token`), refreshes it, and — with `detectSessionInUrl` on —
 * exchanges the tokens on the magic-link redirect fragment before the router
 * gets a chance to see them.
 */
export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
  },
})
