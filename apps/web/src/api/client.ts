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
    throw new ApiFetchError(...(await parseErrorPayload(res)))
  }

  if (!init.schema) return undefined as T
  return init.schema.parse(await res.json())
}

/**
 * Sibling to {@link apiFetch} for endpoints that return raw bytes rather than
 * JSON — today, only `GET /api/v1/documents/:did/snapshots/:sid/state`, which
 * hands us the Yjs update stream to feed into `Y.applyUpdate`.
 *
 * The bearer-token attach path is identical to {@link apiFetch} — that route
 * is `viewer+` gated on the server, so a signed-out caller would 401 anyway;
 * still, we send whatever session Supabase has so a signed-in user's request
 * is authenticated the same way every other call is. Non-2xx responses go
 * through the same {@link ApiFetchError} shape (JSON error envelope on
 * failure paths, per the server's contract).
 *
 * Returns the raw body as a `Uint8Array` — `Y.applyUpdate` and every future
 * on-wire y-protocols consumer want a typed byte view, not an `ArrayBuffer`.
 */
export async function apiFetchBinary(
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const headers = new Headers()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(path, { method: 'GET', headers, signal })

  if (!res.ok) {
    throw new ApiFetchError(...(await parseErrorPayload(res)))
  }

  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Parse the failing-response JSON envelope into `ApiError` — shared between
 * {@link apiFetch} and {@link apiFetchBinary}. When the server did not follow
 * the contract (HTML error page, opaque proxy body), synthesise an envelope
 * with `code: 'malformed'` so callers still see one shape.
 */
async function parseErrorPayload(
  res: Response,
): Promise<[message: string, status: number, payload: ApiError]> {
  let payload: ApiError
  try {
    const parsed = ApiErrorSchema.safeParse(await res.json())
    payload = parsed.success
      ? parsed.data
      : { error: res.statusText || `HTTP ${res.status}`, code: 'malformed' }
  } catch {
    payload = { error: res.statusText || `HTTP ${res.status}`, code: 'malformed' }
  }
  return [payload.error, res.status, payload]
}
