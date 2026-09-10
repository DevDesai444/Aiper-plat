/**
 * Where the compliance engine lives.
 *
 * The engine is the deficiency-chatbot FastAPI service, run separately — `make api` in that
 * repo. Aiper does not start it: doing so would mean resolving a Python environment on
 * every analyst's machine and owning its lifecycle, which is a much worse failure mode than
 * a panel that says the engine is not running.
 *
 * All of this is read in the main process, so the renderer's CSP does not apply and there is
 * no `connect-src` host to keep in step with `ipc/settings.ts`.
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8000'

interface EngineSettings {
  baseUrl: string
  /** Detection model id, or empty to let the engine pick its default. */
  model: string
}

let cached: EngineSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'compliance-engine.json')
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_ENGINE_URL
}

/**
 * Environment first so a machine can be pointed at a shared engine without touching the UI,
 * then the stored override, then localhost.
 */
export function readEngineSettings(): EngineSettings {
  if (cached) return cached

  const fromEnv = process.env.AIPER_COMPLIANCE_URL
  let stored: Partial<EngineSettings> = {}
  try {
    const path = settingsPath()
    if (existsSync(path)) stored = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A corrupt settings file must not stop the app starting; the defaults are fine.
  }

  cached = {
    baseUrl: normaliseUrl(fromEnv || stored.baseUrl || DEFAULT_ENGINE_URL),
    model: (stored.model ?? '').trim()
  }
  return cached
}

export function writeEngineSettings(patch: Partial<EngineSettings>): EngineSettings {
  const next: EngineSettings = { ...readEngineSettings(), ...patch }
  next.baseUrl = normaliseUrl(next.baseUrl)
  cached = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Keep the in-memory value: the setting still applies for this session.
  }
  return next
}

export function engineBaseUrl(): string {
  return readEngineSettings().baseUrl
}

export function selectedModel(): string {
  return readEngineSettings().model
}
