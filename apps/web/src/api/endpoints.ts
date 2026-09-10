import { z } from 'zod'
import type {
  Document,
  Folder,
  Organization,
  Project,
  ProjectFolderTree,
  SessionUser,
} from '@aiper/shared/types'
import {
  DocumentSchema,
  FolderSchema,
  OrganizationSchema,
  ProjectFolderTreeSchema,
  ProjectSchema,
  SessionUserSchema,
} from '@aiper/shared/schemas'
import { apiFetch } from './client'

/**
 * Liveness probe. Shape mirrors apps/server/src/routes/health.ts: 200 carries
 * `db: 'up'`; a 503 comes back as an ApiFetchError with `code: 'malformed'`
 * because the down-body is not an ApiError. The Dashboard reads that as
 * "server offline" — the exact code does not matter for the UI.
 */
const HealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal('aiper-server'),
  version: z.string(),
  db: z.literal('up'),
})

export type Health = z.infer<typeof HealthSchema>

/**
 * The wrapper shape hierarchy list routes use — every list endpoint returns
 * `{ items: T[] }`. Constructing the outer schema here (rather than for every
 * caller) keeps the endpoint fns short and their return types clean.
 */
function listSchema<T>(item: z.ZodType<T>): z.ZodType<{ items: T[] }> {
  return z.object({ items: z.array(item) })
}

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return apiFetch('/api/v1/health', { schema: HealthSchema, signal })
}

export function getMe(signal?: AbortSignal): Promise<SessionUser> {
  return apiFetch('/api/v1/me', { schema: SessionUserSchema, signal })
}

// ─── Hierarchy reads ────────────────────────────────────────────────────────

export async function listOrgs(signal?: AbortSignal): Promise<Organization[]> {
  const { items } = await apiFetch('/api/v1/orgs', {
    schema: listSchema(OrganizationSchema),
    signal,
  })
  return items
}

export async function listProjectsInOrg(
  orgId: string,
  signal?: AbortSignal,
): Promise<Project[]> {
  const { items } = await apiFetch(`/api/v1/orgs/${orgId}/projects`, {
    schema: listSchema(ProjectSchema),
    signal,
  })
  return items
}

export function getProject(pid: string, signal?: AbortSignal): Promise<Project> {
  return apiFetch(`/api/v1/projects/${pid}`, { schema: ProjectSchema, signal })
}

export function getProjectFolderTree(
  pid: string,
  signal?: AbortSignal,
): Promise<ProjectFolderTree> {
  return apiFetch(`/api/v1/projects/${pid}/folders`, {
    schema: ProjectFolderTreeSchema,
    signal,
  })
}

export function getFolder(fid: string, signal?: AbortSignal): Promise<Folder> {
  return apiFetch(`/api/v1/folders/${fid}`, { schema: FolderSchema, signal })
}

export async function listFolderDocuments(
  fid: string,
  signal?: AbortSignal,
): Promise<Document[]> {
  const { items } = await apiFetch(`/api/v1/folders/${fid}/documents`, {
    schema: listSchema(DocumentSchema),
    signal,
  })
  return items
}

export function getDocument(did: string, signal?: AbortSignal): Promise<Document> {
  return apiFetch(`/api/v1/documents/${did}`, { schema: DocumentSchema, signal })
}

// ─── Hierarchy writes ───────────────────────────────────────────────────────

/** Kebab-case slug from a display name; matches the server's SlugSchema. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function createProject(orgId: string, name: string): Promise<Project> {
  return apiFetch('/api/v1/projects', {
    method: 'POST',
    body: { orgId, name, slug: slugify(name) },
    schema: ProjectSchema,
  })
}

export function createFolder(
  pid: string,
  name: string,
  parentFolderId?: string | null,
): Promise<Folder> {
  return apiFetch(`/api/v1/projects/${pid}/folders`, {
    method: 'POST',
    body: { name, parentFolderId: parentFolderId ?? null },
    schema: FolderSchema,
  })
}

export function createDocument(fid: string, title: string): Promise<Document> {
  return apiFetch(`/api/v1/folders/${fid}/documents`, {
    method: 'POST',
    body: { title, kind: 'authored' as const },
    schema: DocumentSchema,
  })
}

export function createProjectDocument(pid: string, title: string): Promise<Document> {
  return apiFetch(`/api/v1/projects/${pid}/documents`, {
    method: 'POST',
    body: { title, kind: 'authored' as const },
    schema: DocumentSchema,
  })
}

export async function listProjectDocuments(
  pid: string,
  signal?: AbortSignal,
): Promise<Document[]> {
  const res = await apiFetch(`/api/v1/projects/${pid}/documents`, {
    schema: z.object({ items: z.array(DocumentSchema) }),
    signal,
  })
  return res.items
}
