/**
 * Runtime validators mirroring the interfaces in ../types/hierarchy.ts.
 * Consumers use these at trust boundaries — request bodies, response
 * serialisation, tests. Every schema pairs 1:1 with a type; keep them in
 * lockstep by editing both files in the same PR.
 */

import { z } from 'zod'

/**
 * Local mirror of AiperRoleSchema from ./index.ts. Inlined rather than
 * imported because ./index.ts re-exports this file (`export * from
 * './hierarchy.js'`) and importing back would put AiperRoleSchema in
 * the temporal dead zone during hierarchy.ts's module init.
 * The three literals here MUST match ./index.ts's AiperRoleSchema —
 * ../types/hierarchy.ts imports the AiperRole type from ./index and
 * would fail typecheck if the union diverged.
 */
const RoleOrNull = z.enum(['viewer', 'editor', 'owner']).nullable()

/**
 * Kebab-case slug used for URL segments. 1..64 chars, lower-case letters
 * and digits, hyphens between runs. Matches typical GitHub/GitLab/Vercel
 * slug conventions; no underscores (they render badly in some URL contexts).
 */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case')

/** Human-visible name of a project or folder. */
const NameSchema = z.string().min(1).max(200)

/** Document title. Longer cap than a folder name — ECSS report titles
 *  routinely run 130+ chars ("Test Report for Thermal Vacuum Testing…"). */
const TitleSchema = z.string().min(1).max(300)

/** ISO 8601 with offset (matches PostgreSQL timestamptz JSON serialisation). */
const IsoDateTimeSchema = z.string().datetime({ offset: true })

export const DocumentKindSchema = z.enum(['authored', 'technical-sheet', 'template'])

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: NameSchema,
  slug: SlugSchema,
  createdAt: IsoDateTimeSchema,
})

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: NameSchema,
  slug: SlugSchema,
  createdBy: z.string().uuid(),
  createdAt: IsoDateTimeSchema,
  myRole: RoleOrNull,
})

export const FolderSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  parentFolderId: z.string().uuid().nullable(),
  name: NameSchema,
  createdBy: z.string().uuid(),
  createdAt: IsoDateTimeSchema,
  myRole: RoleOrNull,
})

export const DocumentSchema = z.object({
  id: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  title: TitleSchema,
  kind: DocumentKindSchema,
  currentSnapshotId: z.string().uuid().nullable(),
  createdBy: z.string().uuid(),
  createdAt: IsoDateTimeSchema,
  myRole: RoleOrNull,
})

export const ProjectFolderTreeSchema = z.object({
  project: ProjectSchema,
  folders: z.array(
    z.object({
      folder: FolderSchema,
      children: z.array(z.object({ id: z.string().uuid(), name: NameSchema })),
      documents: z.array(
        z.object({
          id: z.string().uuid(),
          title: TitleSchema,
          kind: DocumentKindSchema,
        }),
      ),
    }),
  ),
})

export const CommentSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  markId: z.string().min(1).max(128),
  quotedText: z.string().max(4_000),
  body: z.string().min(1).max(10_000),
  authorId: z.string().uuid(),
  authorDisplayName: z.string().min(1).max(200),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  resolvedBy: z.string().uuid().nullable(),
})
