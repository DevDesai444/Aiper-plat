import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { randomBytes, createHash } from 'node:crypto'
import { query, queryOne } from './db.js'
import { writeAudit } from './audit.js'

/**
 * Who you are. Notably there is no role: Aiper has no global authority. What you can do is
 * decided per project by whoever owns that project, and nothing else grants access.
 */
export interface SessionUser {
  id: string
  email: string
  displayName: string
  mustChangePassword: boolean
}

/** 11.300(d): lock an account after repeated failures so credential guessing is bounded. */
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15
/** 11.300(b): passwords must be periodically revised. */
export const PASSWORD_MAX_AGE_DAYS = 90
const SESSION_HOURS = 12

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain)
}

/** Minimum complexity. Deliberately modest — length matters more than symbol soup. */
export function passwordProblem(plain: string): string | null {
  if (plain.length < 10) return 'Password must be at least 10 characters.'
  if (!/[a-zA-Z]/.test(plain)) return 'Password must contain a letter.'
  if (!/[0-9]/.test(plain)) return 'Password must contain a digit.'
  return null
}

interface UserRow {
  id: string
  email: string
  display_name: string
  password_hash: string | null
  active: boolean
  must_change_password: boolean
  failed_login_count: number
  locked_until: Date | null
  password_updated_at: Date | null
}

export interface LoginResult {
  ok: boolean
  token?: string
  user?: SessionUser
  error?: string
  passwordExpired?: boolean
}

export async function login(email: string, password: string, userAgent?: string): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase()
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE lower(email) = $1', [normalized])

  const fail = async (reason: string, publicMessage: string): Promise<LoginResult> => {
    await query('INSERT INTO login_attempts (email, user_id, succeeded, reason) VALUES ($1,$2,false,$3)', [
      normalized,
      user?.id ?? null,
      reason
    ])
    if (user) {
      const failures = user.failed_login_count + 1
      const shouldLock = failures >= MAX_FAILED_ATTEMPTS
      await query(
        `UPDATE users SET failed_login_count = $2,
           locked_until = CASE WHEN $3 THEN now() + interval '${LOCKOUT_MINUTES} minutes' ELSE locked_until END
         WHERE id = $1`,
        [user.id, failures, shouldLock]
      )
      if (shouldLock) {
        // 11.300(d) expects attempted unauthorised use to be reported, not just blocked.
        await writeAudit({
          userId: user.id,
          printedName: user.display_name,
          action: 'auth.account_locked',
          newValue: { failures, lockoutMinutes: LOCKOUT_MINUTES }
        })
      }
    }
    // Same message whether the account exists or not, so the endpoint cannot be used to
    // enumerate valid addresses.
    return { ok: false, error: publicMessage }
  }

  if (!user || !user.password_hash) return fail('unknown_user', 'Incorrect email or password.')
  if (!user.active) return fail('inactive', 'This account is deactivated.')
  if (user.locked_until && user.locked_until > new Date()) {
    return fail('locked', `Account is temporarily locked. Try again after ${user.locked_until.toLocaleTimeString()}.`)
  }

  let valid = false
  try {
    valid = await argonVerify(user.password_hash, password)
  } catch {
    valid = false
  }
  if (!valid) return fail('bad_password', 'Incorrect email or password.')

  const token = randomBytes(32).toString('hex')
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours', $3)`,
    [hashToken(token), user.id, userAgent ?? null]
  )
  await query(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_seen_at = now() WHERE id = $1',
    [user.id]
  )
  await query('INSERT INTO login_attempts (email, user_id, succeeded) VALUES ($1,$2,true)', [normalized, user.id])
  await writeAudit({ userId: user.id, printedName: user.display_name, action: 'auth.login' })

  // Turn any invitations sent to this address into real access. This is what lets someone
  // be added to a project before they have ever opened Aiper.
  await query('SELECT aiper_claim_invitations($1, $2)', [user.id, user.email])

  const ageDays = user.password_updated_at
    ? (Date.now() - user.password_updated_at.getTime()) / 86_400_000
    : Infinity

  return {
    ok: true,
    token,
    passwordExpired: ageDays > PASSWORD_MAX_AGE_DAYS,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      mustChangePassword: user.must_change_password || ageDays > PASSWORD_MAX_AGE_DAYS
    }
  }
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const row = await queryOne<UserRow & { session_id: string }>(
    `SELECT u.*, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`,
    [hashToken(token)]
  )
  if (!row) return null
  await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id])
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    mustChangePassword: row.must_change_password
  }
}

export async function logout(token: string | undefined, user: SessionUser | null): Promise<void> {
  if (!token) return
  await query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)])
  if (user) await writeAudit({ userId: user.id, printedName: user.displayName, action: 'auth.logout' })
}

export async function changePassword(user: SessionUser, current: string, next: string): Promise<string | null> {
  const row = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [user.id])
  if (!row?.password_hash) return 'Account has no password set.'
  if (!(await argonVerify(row.password_hash, current))) return 'Current password is incorrect.'
  const problem = passwordProblem(next)
  if (problem) return problem
  if (await argonVerify(row.password_hash, next)) return 'New password must differ from the current one.'

  await query(
    `UPDATE users SET password_hash = $2, password_updated_at = now(), must_change_password = false WHERE id = $1`,
    [user.id, await hashPassword(next)]
  )
  // Any other session is invalidated — a password change should not leave old sessions live.
  await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id])
  await writeAudit({ userId: user.id, printedName: user.displayName, action: 'auth.password_changed' })
  return null
}
