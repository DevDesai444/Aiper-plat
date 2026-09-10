import type { z } from 'zod'
import type { ApiError } from '@aiper/shared/types'
import { ApiErrorSchema } from '@aiper/shared/schemas'
import { supabase } from '../auth/supabase'

/**
 * Thrown for any non-2xx response. `payload` is the parsed `ApiError` when
 * the server followed the contract; a synthetic `{ error, code: 'malformed' }`
 * when it did not. `status` is the raw HTTP status either way.
 */
export class ApiFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(message)
    this.name = 'ApiFetchError'
  }
}

export interface ApiRequestInit<T> {
  /**
   * Zod schema the response body is parsed against on 2xx. Optional — omit
   * for calls that expect an empty body (204 No Content, e.g. DELETE
   * permissions/invitations). When omitted the returned Promise resolves
   * to `undefined` and the response body is not read; skipping the parse
   * lets 204 responses through without a JSON error.
   */
  schema?: z.ZodType<T>
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Serialized as JSON; sets Content-Type when present. */
  body?: unknown
  signal?: AbortSignal
}

/**
 * The one path every route in this app takes to the Fastify API. Attaches the
 * Supabase JWT as a Bearer token when one exists, parses the response through
 * the caller's Zod schema (or skips parse for schemaless "no content" calls),
 * and turns non-2xx into a typed `ApiFetchError`.
 *
 * `path` MUST start with `/api/...` — the dev server proxies that prefix to
 * Fastify, and the prod build serves the SPA from the same origin. There is
 * deliberately no base-URL config here.
 */
export async function apiFetch<T = void>(
  path: string,
  init: ApiRequestInit<T>,
): Promise<T> {
  const headers = new Headers()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')

  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })

  if (!res.ok) {
    let payload: ApiError
    try {
      const parsed = ApiErrorSchema.safeParse(await res.json())
      payload = parsed.success
        ? parsed.data
        : { error: res.statusText || `HTTP ${res.status}`, code: 'malformed' }
    } catch {
      payload = { error: res.statusText || `HTTP ${res.status}`, code: 'malformed' }
    }
    throw new ApiFetchError(payload.error, res.status, payload)
  }

  if (!init.schema) return undefined as T
  return init.schema.parse(await res.json())
}
