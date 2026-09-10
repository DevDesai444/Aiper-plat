import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { http, HttpResponse } from 'msw'
import { server } from '../msw/server'

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    auth: {
      getSession: vi.fn<() => Promise<{ data: { session: { access_token: string } | null } }>>(),
    },
  },
}))

vi.mock('../../src/auth/supabase', () => ({ supabase: mockSupabase }))

// Import AFTER the mock is in place so apiFetch's `import { supabase }`
// resolves to the mock, not the real module.
const { apiFetch, ApiFetchError } = await import('../../src/api/client')

beforeEach(() => {
  mockSupabase.auth.getSession.mockReset()
  mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } })
})

describe('apiFetch', () => {
  const HealthSchema = z.object({
    ok: z.literal(true),
    service: z.literal('aiper-server'),
    version: z.string(),
  })

  it('attaches Authorization: Bearer when Supabase has a session', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'supa-token-xyz' } },
    })

    let seen: string | null = null
    server.use(
      http.get('/api/v1/health', ({ request }) => {
        seen = request.headers.get('authorization')
        return HttpResponse.json({ ok: true, service: 'aiper-server', version: '0' })
      }),
    )

    await apiFetch('/api/v1/health', { schema: HealthSchema })
    expect(seen).toBe('Bearer supa-token-xyz')
  })

  it('omits Authorization when there is no session', async () => {
    let seen: string | null = 'unset'
    server.use(
      http.get('/api/v1/health', ({ request }) => {
        seen = request.headers.get('authorization')
        return HttpResponse.json({ ok: true, service: 'aiper-server', version: '0' })
      }),
    )

    await apiFetch('/api/v1/health', { schema: HealthSchema })
    expect(seen).toBeNull()
  })

  it('parses the response body through the caller-supplied schema', async () => {
    server.use(
      http.get('/api/v1/health', () =>
        HttpResponse.json({ ok: true, service: 'aiper-server', version: '1.2.3' }),
      ),
    )
    const result = await apiFetch('/api/v1/health', { schema: HealthSchema })
    expect(result).toEqual({ ok: true, service: 'aiper-server', version: '1.2.3' })
  })

  it('throws ApiFetchError with the parsed ApiError payload on 401', async () => {
    server.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json({ error: 'Not signed in', code: 'no_session' }, { status: 401 }),
      ),
    )
    await expect(
      apiFetch('/api/v1/me', { schema: z.unknown() }),
    ).rejects.toMatchObject({
      name: 'ApiFetchError',
      status: 401,
      message: 'Not signed in',
      payload: { error: 'Not signed in', code: 'no_session' },
    })
  })

  it('wraps a malformed error body with code: "malformed"', async () => {
    server.use(
      http.get('/api/v1/me', () => HttpResponse.text('nope', { status: 500 })),
    )
    try {
      await apiFetch('/api/v1/me', { schema: z.unknown() })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiFetchError)
      const e = err as InstanceType<typeof ApiFetchError>
      expect(e.status).toBe(500)
      expect(e.payload.code).toBe('malformed')
    }
  })
})
