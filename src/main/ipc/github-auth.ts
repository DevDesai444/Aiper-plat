import { app, ipcMain, safeStorage } from 'electron'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sign in with GitHub, from the desktop app, with no Aiper server anywhere in the path.
 *
 * The OAuth **device flow** is used rather than the redirect flow because a desktop app has
 * nowhere to redirect to and cannot keep a client secret. The user types a short code on
 * github.com and approves; only a public client id is needed here.
 *
 * This lives in the main process for one specific reason: github.com's OAuth endpoints send no
 * CORS headers, so a fetch from the renderer is blocked by the browser before it is sent. The
 * REST API at api.github.com does send them, so everything after sign-in is called directly
 * from the renderer.
 */
/**
 * Read the client id from the environment, falling back to a `.env` file beside the project.
 *
 * The fallback exists so the id is pasted once rather than prefixed onto every launch command —
 * and so a colleague setting up a second machine edits one line instead of learning to export a
 * variable. Parsed by hand to avoid a dependency for six lines of work.
 */
function readClientId(): string {
  const fromEnv = process.env.AIPER_GITHUB_CLIENT_ID?.trim()
  if (fromEnv) return fromEnv
  for (const candidate of [join(process.cwd(), '.env'), join(app.getAppPath(), '.env')]) {
    try {
      const line = readFileSync(candidate, 'utf8')
        .split('\n')
        .find((l) => l.trim().startsWith('AIPER_GITHUB_CLIENT_ID='))
      const value = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
      if (value) return value
    } catch {
      // No .env here; try the next location.
    }
  }
  return ''
}

const CLIENT_ID = readClientId()
const TOKEN_FILE = (): string => join(app.getPath('userData'), 'github-token')

export function isConfigured(): boolean {
  return CLIENT_ID.length > 0
}

/**
 * The token is encrypted at rest with the OS keychain where one is available. When it is not
 * (a Linux box with no keyring), nothing is stored at all rather than a plaintext token left on
 * disk — signing in again each launch is the better trade.
 */
function saveToken(token: string): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) return
    writeFileSync(TOKEN_FILE(), safeStorage.encryptString(token))
  } catch (err) {
    console.error('[github] could not store token:', err instanceof Error ? err.message : err)
  }
}

function loadToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(TOKEN_FILE()))
  } catch {
    return null
  }
}

function clearToken(): void {
  try {
    rmSync(TOKEN_FILE(), { force: true })
  } catch {
    // Nothing stored, or already gone.
  }
}

interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export function registerGithubAuthIpc(): void {
  ipcMain.handle('github:isConfigured', () => isConfigured())

  /** The token from a previous session, so a restart does not mean signing in again. */
  ipcMain.handle('github:storedToken', () => loadToken())

  ipcMain.handle('github:signOut', () => {
    clearToken()
    return true
  })

  ipcMain.handle('github:startDeviceFlow', async (): Promise<DeviceStart> => {
    if (!isConfigured()) throw new Error('GitHub sign-in is not configured — AIPER_GITHUB_CLIENT_ID is unset.')

    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      // repo: projects are private repositories, and the app reads and writes their contents.
      // read:user + user:email: to know who signed in and at what address.
      body: JSON.stringify({ client_id: CLIENT_ID, scope: 'repo read:user user:email' })
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
  })

  /** `pending` is the normal answer until the user approves; the renderer keeps polling. */
  ipcMain.handle('github:pollDeviceFlow', async (_event, deviceCode: unknown) => {
    if (typeof deviceCode !== 'string') return { status: 'error', error: 'Missing device code.' }

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

    saveToken(data.access_token)
    return { status: 'ok', token: data.access_token }
  })
}
