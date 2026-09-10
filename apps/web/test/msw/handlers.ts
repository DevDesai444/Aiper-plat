import { http, HttpResponse } from 'msw'

/**
 * A valid UUID for the fake user — the shared `SessionUserSchema` uses
 * `z.string().uuid()`, so a stub like "user-1" would fail parse before the
 * assertion under test.
 */
export const FAKE_USER_ID = '11111111-1111-4111-8111-111111111111'
export const FAKE_ORG_ID = '22222222-2222-4222-8222-222222222222'

export const handlers = [
  http.get('/api/v1/health', () =>
    HttpResponse.json({ ok: true, service: 'aiper-server', version: '0.0.0-test' }),
  ),
  http.get('/api/v1/me', () =>
    HttpResponse.json({
      id: FAKE_USER_ID,
      email: 'alice@example.com',
      displayName: 'Alice',
      avatarUrl: null,
      orgMemberships: [{ orgId: FAKE_ORG_ID, role: 'admin' as const }],
    }),
  ),
]
