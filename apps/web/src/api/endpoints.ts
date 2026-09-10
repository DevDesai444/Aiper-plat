import { z } from 'zod'
import type { SessionUser } from '@aiper/shared/types'
import { SessionUserSchema } from '@aiper/shared/schemas'
import { apiFetch } from './client'

/**
 * Liveness probe. Public — no auth needed on the server side either. Shape is
 * defined locally rather than in `@aiper/shared` because health is an
 * operational endpoint, not a domain contract.
 */
const HealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal('aiper-server'),
  version: z.string(),
})

export type Health = z.infer<typeof HealthSchema>

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return apiFetch('/api/v1/health', { schema: HealthSchema, signal })
}

export function getMe(signal?: AbortSignal): Promise<SessionUser> {
  return apiFetch('/api/v1/me', { schema: SessionUserSchema, signal })
}
