import { randomBytes } from 'node:crypto'
import { query, queryOne } from './db.js'
import { writeAudit } from './audit.js'
import { hashToken, type SessionUser } from './auth.js'

/**
 * Sign in with GitHub, using the OAuth **device flow**.
 *
 * Device flow rather than the usual redirect flow because Aiper is a desktop app:
 *   - there is no client secret to embed (a desktop binary cannot keep one),
 *   - there is no redirect URI, so no loopback HTTP server and no custom URL scheme to register,
 *   - the user types a short code on github.com, which is the same gesture on every machine.
 *
 * The only configuration is a public client id. Set AIPER_GITHUB_CLIENT_ID; when it is unset,
 * isConfigured() is false and the app falls back to email/password sign-in instead of showing a
 * button that cannot work.
 */
const CLIENT_ID = process.env.AIPER_GITHUB_CLIENT_ID ?? ''
const SESSION_HOURS = 12

export function isConfigured(): boolean {
  return CLIENT_ID.length > 0
}

export interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

/** Ask GitHub for a code pair. The user types userCode at verificationUri. */
export async function startDeviceFlow(): Promise<DeviceStart> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    // read:user and user:email — enough to know who signed in and at what address.
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user user:email' })
  })
  const data = (await res.json()) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    interval?: number
    expires_in?: number
    error_description?: string
  }
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(data.error_description ?? 'GitHub refused to start sign-in.')
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval ?? 5,
    expiresIn: data.expires_in ?? 900
  }
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'ok'; token: string; user: SessionUser }

/**
 * Exchange the device code for a session, once the user has approved on github.com.
 * `pending` is the normal answer until they do; the client keeps polling.
 */
export async function pollDeviceFlow(deviceCode: string, userAgent?: string): Promise<PollResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  })
  const data = (await res.json()) as { access_token?: string; error?: string; interval?: number }

  if (data.error === 'authorization_pending') return { status: 'pending' }
  if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval ?? 10 }
  if (data.error === 'expired_token') return { status: 'expired' }
  if (data.error === 'access_denied') return { status: 'denied' }
  if (!data.access_token) return { status: 'pending' }

  const gh = await githubIdentity(data.access_token)
  const user = await upsertGithubUser(gh)

  const token = randomBytes(32).toString('hex')
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours', $3)`,
    [hashToken(token), user.id, userAgent ?? null]
  )
  await query('UPDATE users SET last_seen_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [
    user.id
  ])
  await query('INSERT INTO login_attempts (email, user_id, succeeded, reason) VALUES ($1,$2,true,$3)', [
    user.email,
    user.id,
    'github'
  ])
  await writeAudit({ userId: user.id, printedName: user.displayName, action: 'auth.login', newValue: { via: 'github' } })

  // Any project this address was invited to becomes real access now.
  await query('SELECT aiper_claim_invitations($1, $2)', [user.id, user.email])

  return { status: 'ok', token, user }
}

interface GithubIdentity {
  id: number
  login: string
  name: string | null
  email: string
  avatarUrl: string | null
}

async function githubIdentity(accessToken: string): Promise<GithubIdentity> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' }

  const me = (await (await fetch('https://api.github.com/user', { headers })).json()) as {
    id?: number
    login?: string
    name?: string | null
    email?: string | null
    avatar_url?: string | null
  }
  if (!me.id || !me.login) throw new Error('GitHub did not return an account.')

  // /user omits the email when the profile hides it, so ask the emails endpoint and take the
  // primary verified address. An unverified address must not become an identity: invitations
  // are addressed to emails, so accepting one would let anyone claim another person's invite.
  let email = me.email ?? null
  if (!email) {
    const emails = (await (await fetch('https://api.github.com/user/emails', { headers })).json()) as Array<{
      email: string
      primary: boolean
      verified: boolean
    }>
    email = emails?.find((e) => e.primary && e.verified)?.email ?? emails?.find((e) => e.verified)?.email ?? null
  }
  if (!email) {
    throw new Error('Your GitHub account has no verified email address. Add and verify one, then sign in again.')
  }

  return { id: me.id, login: me.login, name: me.name ?? null, email: email.toLowerCase(), avatarUrl: me.avatar_url ?? null }
}

/**
 * Find or create the user row for a GitHub identity.
 *
 * Matched on github_id first (immutable), then on email so that somebody invited by address —
 * or an account that predates GitHub sign-in — is adopted rather than duplicated. 11.100(a):
 * rows are only ever created or updated here, never reassigned to a different person, because
 * github_id is unique and never changes hands.
 */
async function upsertGithubUser(gh: GithubIdentity): Promise<SessionUser> {
  const displayName = gh.name?.trim() || gh.login

  let row = await queryOne<{ id: string; email: string; display_name: string; active: boolean }>(
    'SELECT id, email, display_name, active FROM users WHERE github_id = $1',
    [gh.id]
  )

  if (!row) {
    row = await queryOne<{ id: string; email: string; display_name: string; active: boolean }>(
      `UPDATE users SET github_id = $1, github_login = $2, avatar_url = $3
        WHERE lower(email) = $4 AND github_id IS NULL
        RETURNING id, email, display_name, active`,
      [gh.id, gh.login, gh.avatarUrl, gh.email]
    )
  }

  if (!row) {
    row = await queryOne<{ id: string; email: string; display_name: string; active: boolean }>(
      `INSERT INTO users (email, display_name, github_id, github_login, avatar_url, must_change_password)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id, email, display_name, active`,
      [gh.email, displayName, gh.id, gh.login, gh.avatarUrl]
    )
    await writeAudit({
      userId: row!.id,
      printedName: displayName,
      action: 'user.created',
      newValue: { email: gh.email, githubLogin: gh.login, via: 'github' }
    })
  } else {
    // Keep the profile current; the login and avatar can change on GitHub at any time.
    await query('UPDATE users SET github_login = $2, avatar_url = $3, display_name = $4 WHERE id = $1', [
      row.id,
      gh.login,
      gh.avatarUrl,
      displayName
    ])
  }

  if (!row!.active) throw new Error('This account is deactivated.')

  return { id: row!.id, email: row!.email, displayName, mustChangePassword: false }
}
