import type pg from 'pg'
import type { SessionUser } from '@aiper/shared/types'

type OrgMembership = SessionUser['orgMemberships'][number]

/**
 * On every request that presents a valid JWT: keep our local users
 * mirror in sync with what Supabase says, and turn any invitations
 * addressed to this user's email into real user grants.
 *
 * Both writes run in one transaction so a partial claim (users row
 * exists, invites still keyed to the email) cannot persist across a
 * crash.
 *
 * Idempotent:
 *   - users INSERT ... ON CONFLICT DO UPDATE — the second and later
 *     requests just refresh email / display_name / avatar_url if any
 *     changed in Supabase.
 *   - access_grants UPDATE — after the first sign-in, no invite rows
 *     match this email any more (their principal_type moved to 'user').
 */
export async function provisionAndClaim(pool: pg.Pool, jwtUser: SessionUser): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `INSERT INTO users (id, email, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET email        = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             avatar_url   = EXCLUDED.avatar_url,
             updated_at   = now()`,
      [jwtUser.id, jwtUser.email, jwtUser.displayName, jwtUser.avatarUrl],
    )

    // One deployment = one organization. Every authenticated user is a
    // member of it — membership is what lets them create projects; it
    // grants no access to any project's content (that stays explicit
    // via access_grants).
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT id, $1, 'member' FROM organizations WHERE slug = 'default'
       ON CONFLICT DO NOTHING`,
      [jwtUser.id],
    )

    // Case-insensitive email match — Supabase gives us the address in
    // whatever case the user typed, and E2's invitation writer may or
    // may not normalize. LOWER on both sides means the claim is safe
    // regardless.
    await client.query(
      `UPDATE access_grants
          SET principal_type = 'user',
              principal_id   = $1::text
        WHERE principal_type = 'invite'
          AND lower(principal_id) = lower($2)`,
      [jwtUser.id, jwtUser.email],
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Read the org_members rows for one user. Called once per authenticated
 * request; the middleware caches the result on req.user for the request
 * lifetime so downstream handlers don't re-query.
 */
export async function fetchOrgMemberships(pool: pg.Pool, userId: string): Promise<OrgMembership[]> {
  const r = await pool.query<{ org_id: string; role: 'admin' | 'member' }>(
    'SELECT org_id, role FROM org_members WHERE user_id = $1',
    [userId],
  )
  return r.rows.map((row) => ({ orgId: row.org_id, role: row.role }))
}
