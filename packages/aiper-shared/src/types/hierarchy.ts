/**
 * Week-2 interface freeze for the hierarchy layer: organizations → projects →
 * folders → documents, plus the tree endpoint's shape and the Comment record.
 * These are the contract E6's Navigator and every other consumer reads
 * against — do not fork them; change here and re-publish the package.
 *
 * UploadResponse and its constants freeze in week 5 and will land in a
 * follow-up PR alongside the blob work.
 */

import type { AiperRole } from './index.js'

/** An organization — the top of the hierarchy. */
export interface Organization {
  id: string
  name: string
  slug: string
  createdAt: string  // ISO 8601, with offset
}

/**
 * A project within an organization. `myRole` is the caller's effective role
 * on this project as returned by the resolver; null when the caller has no
 * grant anywhere on this project's chain. Always populated on any read that
 * comes from an authenticated request.
 */
export interface Project {
  id: string
  orgId: string
  name: string
  slug: string
  createdBy: string
  createdAt: string
  myRole: AiperRole | null
}

/**
 * A folder inside a project. `parentFolderId` is null for a folder at the
 * project's root. `myRole` follows the same rule as Project.myRole.
 */
export interface Folder {
  id: string
  projectId: string
  parentFolderId: string | null
  name: string
  createdBy: string
  createdAt: string
  myRole: AiperRole | null
}

/**
 * A document's kind. `authored` documents are user-authored via E3's Yjs
 * editor. `technical-sheet` documents are created by E4's upload flow (product
 * tree / component sheets). `template` is reserved for a future create-flow.
 * The base Document schema accepts all three; POST /api/v1/documents rejects
 * anything except `authored`.
 */
export type DocumentKind = 'authored' | 'technical-sheet' | 'template'

/**
 * A document. `currentSnapshotId` is filled by E3 when snapshots exist; null
 * on a document created but not yet saved.
 */
export interface Document {
  id: string
  folderId: string
  title: string
  kind: DocumentKind
  currentSnapshotId: string | null
  createdBy: string
  createdAt: string
  myRole: AiperRole | null
}

/**
 * Response shape of GET /api/v1/projects/:pid/folders — the Navigator's
 * source of truth. `folders` is a DFS preorder walk from the project root,
 * siblings ordered alphabetically (name, lowercased). Every folder the
 * caller can reach appears exactly once; folders and subtrees they cannot
 * reach are omitted rather than hidden-locked (regulated content safer
 * default: do not reveal the existence of a document without access).
 *
 * `children` and `documents` inside each entry are lightweight summaries;
 * fetch a specific folder or document for the full shape.
 */
export interface ProjectFolderTree {
  project: Project
  folders: Array<{
    folder: Folder
    children: Array<{ id: string; name: string }>
    documents: Array<{ id: string; title: string; kind: DocumentKind }>
  }>
}

/**
 * A comment anchored to a `markId` inside a document. `markId` is the client-
 * side id of the Yjs mark the comment attaches to — the editor renders the
 * comment where the mark lives. `authorDisplayName` is denormalised at read
 * time so a list of comments doesn't need a separate users join.
 * `resolvedBy` names the user who marked the thread resolved.
 */
export interface Comment {
  id: string
  documentId: string
  markId: string
  quotedText: string
  body: string
  authorId: string
  authorDisplayName: string
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}
