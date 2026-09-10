import { z } from 'zod'
import type { AiperRole, AiperSubject } from '@aiper/shared/types'
import { AiperRoleSchema } from '@aiper/shared/schemas'
import { apiFetch } from './client'

/**
 * Access management endpoint bindings — the six calls the Share dialog
 * dispatches, plus the two reads it renders.
 *
 * The WRITE endpoints are on main (E2's PR-5b, commit 3f3c321). The READ
 * endpoints (`GET .../members`, `GET .../invitations`) are E2's next PR;
 * the local Zod schemas below are our best-guess shapes so the dialog
 * consumes them as if they were live. When E2 publishes the frozen shapes
 * in @aiper/shared, swap the imports below and delete the locals — no
 * component change needed.
 *
 * Convention: three subject types (project/folder/document) share the
 * same route grammar. Rather than duplicating six calls three times each,
 * this module maps AiperSubject -> base path once and parameterises.
 */

const BASE_PATH: Record<AiperSubject, string> = {
  project: '/api/v1/projects',
  folder: '/api/v1/folders',
  document: '/api/v1/documents',
}

// ─── READ shapes — local until E2 publishes the freeze ─────────────────────

/**
 * A user who currently holds a grant on the subject, whether that grant is
 * direct or inherited from an ancestor.
 *
 * `inherited` is true when the grant comes from an ancestor subject in the
 * project/folder/document chain — the Share dialog cannot edit those here,
 * you manage them on the ancestor. `source` names the ancestor for a
 * "managed on the {parent}" hint; absent when inherited is false.
 */
export const MemberSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  role: AiperRoleSchema,
  inherited: z.boolean(),
  source: z
    .object({
      subjectType: z.enum(['project', 'folder', 'document']),
      subjectId: z.string().uuid(),
    })
    .optional(),
})
export type Member = z.infer<typeof MemberSchema>

/**
 * A pending invitation — an access_grants row keyed by email that will
 * convert to a user-keyed grant on that email's first sign-in
 * (provisionAndClaim in E1's PR-5).
 */
export const InvitationSchema = z.object({
  email: z.string().email(),
  role: AiperRoleSchema,
  invitedAt: z.string().datetime({ offset: true }),
  invitedByName: z.string().optional(),
})
export type Invitation = z.infer<typeof InvitationSchema>

const MembersResponseSchema = z.object({ items: z.array(MemberSchema) })
const InvitationsResponseSchema = z.object({ items: z.array(InvitationSchema) })

// ─── WRITE response shapes — mirror the server's Zod (permissions.ts / invitations.ts) ──

const GrantResponseSchema = z.object({
  subjectType: z.enum(['project', 'folder', 'document']),
  subjectId: z.string().uuid(),
  userId: z.string().uuid(),
  role: AiperRoleSchema,
})
export type GrantResponse = z.infer<typeof GrantResponseSchema>

const InviteResponseSchema = z.object({
  subjectType: z.enum(['project', 'folder', 'document']),
  subjectId: z.string().uuid(),
  role: AiperRoleSchema,
  immediate: z.boolean(),
  email: z.string(),
})
export type InviteResponse = z.infer<typeof InviteResponseSchema>

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function listMembers(
  subjectType: AiperSubject,
  subjectId: string,
  signal?: AbortSignal,
): Promise<Member[]> {
  const { items } = await apiFetch(
    `${BASE_PATH[subjectType]}/${subjectId}/members`,
    { schema: MembersResponseSchema, signal },
  )
  return items
}

export async function listInvitations(
  subjectType: AiperSubject,
  subjectId: string,
  signal?: AbortSignal,
): Promise<Invitation[]> {
  const { items } = await apiFetch(
    `${BASE_PATH[subjectType]}/${subjectId}/invitations`,
    { schema: InvitationsResponseSchema, signal },
  )
  return items
}

// ─── Writes ────────────────────────────────────────────────────────────────

export function grantPermission(
  subjectType: AiperSubject,
  subjectId: string,
  userId: string,
  role: AiperRole,
): Promise<GrantResponse> {
  return apiFetch(`${BASE_PATH[subjectType]}/${subjectId}/permissions`, {
    method: 'POST',
    body: { userId, role },
    schema: GrantResponseSchema,
  })
}

export function revokePermission(
  subjectType: AiperSubject,
  subjectId: string,
  userId: string,
): Promise<void> {
  return apiFetch(
    `${BASE_PATH[subjectType]}/${subjectId}/permissions/${userId}`,
    { method: 'DELETE' },
  )
}

export function sendInvitation(
  subjectType: AiperSubject,
  subjectId: string,
  email: string,
  role: AiperRole,
): Promise<InviteResponse> {
  return apiFetch(`${BASE_PATH[subjectType]}/${subjectId}/invitations`, {
    method: 'POST',
    body: { email, role },
    schema: InviteResponseSchema,
  })
}

export function revokeInvitation(
  subjectType: AiperSubject,
  subjectId: string,
  email: string,
): Promise<void> {
  // Email must be URL-encoded — a `+` in an address (e.g. filter tag) would
  // otherwise decode server-side as a space.
  return apiFetch(
    `${BASE_PATH[subjectType]}/${subjectId}/invitations/${encodeURIComponent(email)}`,
    { method: 'DELETE' },
  )
}
