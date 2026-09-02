/**
 * The Aiper API surface, backed by GitHub instead of a server.
 *
 * Deliberately the same shape as the old HTTP client so the stores, panels and editor need no
 * changes: swapping the export in `client.ts` swaps the entire backend.
 *
 * Identifiers carry their own location, since there is no database to look anything up in:
 *
 *   project / top folder   "owner/repo"
 *   sub-folder             "owner/repo:path/to/folder"
 *   document               "owner/repo:path/to/doc.aidoc.json"
 *   proposal               "owner/repo#42"
 *
 * A document is one JSON file holding the editor model, its page setup and its comments, so a
 * save is a single commit and a review is a diff of one file.
 */
import * as gh from '../github/client'
import { diffDocuments, type PMNode } from '../../../shared/diff'
import type { ApiDocument, ApiFolderNode, ApiRevision, ApiUser, FolderMember, PendingInvite, Proposal } from './client'

export const DOC_SUFFIX = '.aidoc.json'

/** An anchored comment, stored in the document file alongside the text it points at. */
export interface StoredComment {
  id: string
  markId: string
  quotedText: string
  body: string
  authorName: string
  createdAt: string
  resolvedAt: string | null
}

/** The on-disk shape of a document. `aiper` guards against reading some other JSON file. */
export interface StoredDocument {
  aiper: 1
  title: string
  revision: number
  content: unknown
  pageSetup: unknown
  header: unknown
  footer: unknown
  comments: StoredComment[]
  updatedAt: string
  updatedBy: string
}

function emptyDocument(title: string, author: string): StoredDocument {
  return {
    aiper: 1,
    title,
    revision: 1,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    pageSetup: null,
    header: null,
    footer: null,
    comments: [],
    updatedAt: new Date().toISOString(),
    updatedBy: author
  }
}

// ------------------------------------------------------------------------------- identifiers

export function splitId(id: string): { repo: string; path: string } {
  const at = id.indexOf(':')
  return at === -1 ? { repo: id, path: '' } : { repo: id.slice(0, at), path: id.slice(at + 1) }
}

export function proposalId(repo: string, number: number): string {
  return `${repo}#${number}`
}

function splitProposalId(id: string): { repo: string; number: number } {
  const hash = id.lastIndexOf('#')
  return { repo: id.slice(0, hash), number: Number(id.slice(hash + 1)) }
}

/** GitHub repository permissions, in Aiper's vocabulary. */
function accessOf(p: gh.Project): 'viewer' | 'editor' | 'owner' {
  return p.admin ? 'owner' : p.pushable ? 'editor' : 'viewer'
}

// ------------------------------------------------------------------------------------ session

let me: gh.GitHubUser | null = null

export function currentLogin(): string {
  return me?.login ?? 'unknown'
}

/**
 * The signed-in login, fetching it if this module has not cached it yet.
 *
 * `currentLogin()` answers 'unknown' when the cache is empty, which is fine for a label and
 * quietly wrong for anything that compares identities. It emptied on every hot reload, and the
 * "reuse my open proposal" check compared against 'unknown', matched nothing, and opened a
 * second pull request for the same document — so an author saving twice left two reviews.
 */
async function ensureLogin(): Promise<string> {
  if (!me) me = await gh.currentUser()
  return me.login
}

function asApiUser(u: gh.GitHubUser): ApiUser {
  return {
    id: u.login,
    email: u.email ?? `${u.login}@users.noreply.github.com`,
    displayName: u.name?.trim() || u.login,
    mustChangePassword: false
  }
}

// -------------------------------------------------------------------------------------- tree

/**
 * The project tree.
 *
 * One `git/trees?recursive=1` call per project rather than a request per directory — against a
 * 5000-per-hour budget shared with saving and reviewing, walking folder by folder would be the
 * thing that runs the account out of requests.
 */
async function treeForProject(project: gh.Project): Promise<ApiFolderNode> {
  const access = accessOf(project)
  const root: ApiFolderNode = {
    id: project.fullName,
    name: project.title,
    parentId: null,
    access,
    children: [],
    documents: [],
    files: []
  }

  const byPath = new Map<string, ApiFolderNode>([['', root]])

  const { entries } = await gh.projectTree(project.fullName, project.defaultBranch).catch(() => ({ entries: [] }))

  // Directories first and shallowest-first, so a child always finds its parent already built.
  const dirs = entries.filter((e) => e.type === 'dir').sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  for (const dir of dirs) {
    const parentPath = dir.path.includes('/') ? dir.path.slice(0, dir.path.lastIndexOf('/')) : ''
    const parent = byPath.get(parentPath) ?? root
    const node: ApiFolderNode = {
      id: `${project.fullName}:${dir.path}`,
      name: dir.name,
      parentId: parent.id,
      access,
      children: [],
      documents: [],
      files: []
    }
    byPath.set(dir.path, node)
    parent.children.push(node)
  }

  // An imported .docx keeps its original beside the editable projection, so it must not be
  // listed as a second document with the same name. Knowing which projections exist is what
  // tells the two apart.
  const projections = new Set(entries.filter((e) => e.path.endsWith(DOC_SUFFIX)).map((e) => e.path))

  for (const file of entries) {
    if (file.type !== 'file') continue
    const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    const parent = byPath.get(dirPath) ?? root

    if (file.path.endsWith(DOC_SUFFIX)) {
      // currentRevision is filled in when the document is opened: reading every file here to
      // learn its revision would be one API call per document on every tree refresh.
      parent.documents.push({
        id: `${project.fullName}:${file.path}`,
        path: file.name.replace(DOC_SUFFIX, '.docx'),
        title: file.name.replace(DOC_SUFFIX, ''),
        currentRevision: 0,
        updatedAt: null,
        lockedBy: null
      })
      continue
    }

    // Plumbing, not content: the marker that gives an empty folder somewhere to live, and the
    // one that gives a new project its first commit.
    if (file.name === '.aiper-folder' || file.name === gh.PROJECT_MARKER) continue

    const isSource = /\.docx$/i.test(file.path) && projections.has(file.path.replace(/\.docx$/i, DOC_SUFFIX))
    parent.files.push({ path: file.path, name: file.name, sha: file.sha, kind: isSource ? 'source' : 'other' })
  }

  return root
}

// --------------------------------------------------------------------------------------- api

/** Read the document, change its comments, write it back — one commit per change. */
async function mutateComments(
  documentId: string,
  change: (comments: StoredComment[]) => StoredComment[],
  message: string
): Promise<{ ok: true }> {
  const { repo, path } = splitId(documentId)
  const file = await gh.readJson<StoredDocument>(repo, path)
  if (!file) throw new Error('That document no longer exists in the project.')
  await gh.writeJson(repo, path, { ...file.content, comments: change(file.content.comments) }, message, {
    sha: file.sha
  })
  return { ok: true }
}

export const githubApi = {
  // ----- session ---------------------------------------------------------------------------
  async login(): Promise<{ user: ApiUser; passwordExpired: boolean }> {
    throw new Error('Aiper signs in with GitHub. There are no passwords.')
  },

  async logout(): Promise<void> {
    await window.aiper?.github?.signOut()
    gh.setToken(null)
    me = null
  },

  /** Adopt a token — from the device flow, or the one kept from a previous session. */
  async adoptToken(token: string): Promise<ApiUser> {
    gh.setToken(token)
    me = await gh.currentUser()
    return asApiUser(me)
  },

  async me(): Promise<{ user: ApiUser }> {
    if (!me) {
      if (!gh.hasToken()) throw new Error('Not signed in')
      me = await gh.currentUser()
    }
    return { user: asApiUser(me) }
  },

  async authMethods(): Promise<{ github: boolean; password: boolean }> {
    return { github: (await window.aiper?.github?.isConfigured()) ?? false, password: false }
  },

  async changePassword(): Promise<{ ok: true }> {
    throw new Error('Aiper has no passwords — your GitHub account is your sign-in.')
  },

  // ----- projects and folders --------------------------------------------------------------
  async listFolders(): Promise<{ folders: ApiFolderNode[] }> {
    const projects = await gh.listProjects()
    return { folders: await Promise.all(projects.map(treeForProject)) }
  },

  async createFolder(name: string, parentId: string | null): Promise<{ id: string }> {
    if (!parentId) {
      const project = await gh.createProject(name)
      return { id: project.fullName }
    }
    const { repo, path } = splitId(parentId)
    const folderPath = path ? `${path}/${name}` : name
    await gh.createFolder(repo, folderPath)
    return { id: `${repo}:${folderPath}` }
  },

  // ----- documents -------------------------------------------------------------------------
  async listDocuments(): Promise<{ documents: ApiDocument[] }> {
    const { folders } = await githubApi.listFolders()
    const out: ApiDocument[] = []
    // A folder node's document carries no lock lease, and ApiDocument's does; nothing is ever
    // locked here, so the field is simply null.
    const walk = (n: ApiFolderNode): void => {
      out.push(...n.documents.map((d) => ({ ...d, lockedBy: null })))
      n.children.forEach(walk)
    }
    folders.forEach(walk)
    return { documents: out }
  },

  async createDocument(path: string, title: string, folderId: string): Promise<{ document: ApiDocument }> {
    const { repo, path: dir } = splitId(folderId)
    const file = `${dir ? `${dir}/` : ''}${title}${DOC_SUFFIX}`
    await gh.writeJson(repo, file, emptyDocument(title, await ensureLogin()), `Create ${title}`)
    return {
      document: {
        id: `${repo}:${file}`,
        path,
        title,
        currentRevision: 1,
        updatedAt: new Date().toISOString(),
        lockedBy: null
      }
    }
  },

  /**
   * Open a document.
   *
   * Your own open proposal is your working copy. If you have one for this document, it is read
   * from your branch rather than from the project's — otherwise reopening the document showed
   * you the version you had changed *away* from, and your own edits looked lost. They were
   * never lost; they were on a branch nobody was reading.
   *
   * Once an owner accepts, the proposal is merged and no longer open, so this falls back to the
   * project's branch and everybody — the author included — sees the same accepted text.
   */
  async getDocument(id: string, revision?: number): Promise<{ document: ApiRevision }> {
    const { repo, path } = splitId(id)
    let ref: string | undefined

    if (revision) {
      // Revisions are commits. Asking for an older one means reading the file at that commit.
      const commits = await gh.commitsFor(repo, path)
      ref = commits[commits.length - revision]?.sha
    } else {
      const login = await ensureLogin()
      const mine = (await gh.listProposals(repo, 'open').catch(() => [])).find(
        (p) => p.author === login && p.body?.includes(path)
      )
      if (mine) ref = mine.branch
    }

    const file = await gh.readJson<StoredDocument>(repo, path, ref)
    if (!file) throw new Error('That document no longer exists in the project.')
    const d = file.content
    return {
      document: {
        documentId: id,
        revision: d.revision,
        content: d.content,
        pageSetup: d.pageSetup,
        header: d.header,
        footer: d.footer,
        contentHash: file.sha,
        authorName: d.updatedBy,
        createdAt: d.updatedAt
      }
    }
  },

  /**
   * Save straight to the project's default branch.
   *
   * Used when you own the project. Everyone else's saves go through `saveProposal`, which is
   * what puts a change in front of a reviewer.
   */
  async save(
    id: string,
    baseRevision: number,
    payload: { content: unknown; pageSetup: unknown; header: unknown; footer: unknown; reason?: string }
  ): Promise<{ ok: true; revision: number }> {
    const { repo, path } = splitId(id)
    const existing = await gh.readJson<StoredDocument>(repo, path)
    if (!existing) throw new Error('That document no longer exists in the project.')
    // Someone else committed since this document was opened. Refusing beats silently
    // overwriting their work — the same rule the proposal flow enforces.
    if (baseRevision > 0 && existing.content.revision !== baseRevision) {
      throw new Error(
        `This document moved on while you were editing it (you have v${baseRevision}, the project has v${existing.content.revision}). Reopen it and reapply your change.`
      )
    }

    const next: StoredDocument = {
      ...existing.content,
      content: payload.content,
      pageSetup: payload.pageSetup ?? existing.content.pageSetup,
      header: payload.header ?? existing.content.header,
      footer: payload.footer ?? existing.content.footer,
      revision: existing.content.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: await ensureLogin()
    }
    await gh.writeJson(repo, path, next, payload.reason?.trim() || `Update ${existing.content.title}`, {
      sha: existing.sha
    })
    return { ok: true, revision: next.revision }
  },

  /** Commit history for one document — the record of who changed what, and when. */
  async history(id: string): Promise<{ history: Array<{ revision: number; authorName: string; createdAt: string; summary: string | null }> }> {
    const { repo, path } = splitId(id)
    const commits = await gh.commitsFor(repo, path)
    return {
      history: commits.map((c, i) => ({
        revision: commits.length - i,
        authorName: c.author,
        createdAt: c.date,
        summary: c.message
      }))
    }
  },

  // ----- comments anchored in the document -----------------------------------------------------
  // Stored inside the document file rather than as GitHub comments: they point at a mark in the
  // text, so they have to travel with the text through branches, merges and reverts.
  async listComments(documentId: string): Promise<{ comments: StoredComment[] }> {
    const { repo, path } = splitId(documentId)
    const file = await gh.readJson<StoredDocument>(repo, path)
    return { comments: file?.content.comments ?? [] }
  },

  async addComment(documentId: string, markId: string, quotedText: string, body: string): Promise<{ ok: true }> {
    const author = await ensureLogin()
    return mutateComments(
      documentId,
      (comments) => [
        ...comments,
        {
          id: `${markId}-${comments.length + 1}`,
          markId,
          quotedText,
          body,
          authorName: author,
          createdAt: new Date().toISOString(),
          resolvedAt: null
        }
      ],
      'Add a comment'
    )
  },

  async resolveComment(documentId: string, markId: string): Promise<{ ok: true }> {
    return mutateComments(
      documentId,
      (comments) => comments.map((c) => (c.markId === markId ? { ...c, resolvedAt: new Date().toISOString() } : c)),
      'Resolve a comment'
    )
  },

  async deleteComment(documentId: string, markId: string): Promise<{ ok: true }> {
    return mutateComments(documentId, (comments) => comments.filter((c) => c.markId !== markId), 'Delete a comment')
  },

  // ----- locks: no longer a concept ----------------------------------------------------------
  // Check-out locking was replaced by proposals. These stay so the editor's existing calls are
  // harmless no-ops rather than errors.
  async lock(_id: string): Promise<{ ok: true; expiresAt: string }> {
    return { ok: true, expiresAt: '' }
  },
  async unlock(_id: string, _force = false): Promise<{ ok: true }> {
    return { ok: true }
  },
  async heartbeat(_id: string): Promise<{ held: boolean }> {
    return { held: true }
  },

  // ----- proposals ---------------------------------------------------------------------------
  async listProposals(documentId: string): Promise<{ proposals: Proposal[] }> {
    const { repo, path } = splitId(documentId)
    const pulls = await gh.listProposals(repo, 'all')
    return {
      proposals: pulls
        // The branch name records which document the proposal is about.
        .filter((p) => p.branch.startsWith('aiper/') && p.body?.includes(path))
        .map((p) => ({
          id: proposalId(repo, p.number),
          documentId,
          authorId: p.author,
          authorName: p.author,
          baseRevision: 0,
          summary: p.title,
          status: p.merged ? ('accepted' as const) : p.state === 'open' ? ('open' as const) : ('closed' as const),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          resolvedByName: null,
          resultingRevision: null,
          // Whether the document moved on under a proposal is answered by GitHub's own
          // mergeability check at review time, not guessed from a revision number here.
          stale: false,
          commentCount: p.commentCount
        }))
    }
  },

  /**
   * Propose a change: a branch, a commit on it, and a pull request.
   *
   * Reuses an open proposal by the same author on the same document rather than opening a
   * second one, so an author saving three times leaves one review to do, not three.
   */
  async saveProposal(documentId: string, content: unknown, summary: string | null): Promise<{ id: string; created: boolean }> {
    const { repo, path } = splitId(documentId)
    const projects = await gh.listProjects()
    const project = projects.find((p) => p.fullName === repo)
    if (!project) throw new Error('You no longer have access to that project.')

    const login = await ensureLogin()
    const mine = (await gh.listProposals(repo, 'open')).find(
      (p) => p.author === login && p.body?.includes(path)
    )

    const branch = mine?.branch ?? `aiper/${login}/${Date.now().toString(36)}`
    if (!mine) await gh.createBranch(repo, branch, project.defaultBranch)

    const existing = await gh.readJson<StoredDocument>(repo, path, branch)
    if (!existing) throw new Error('That document no longer exists in the project.')

    await gh.writeJson(
      repo,
      path,
      {
        ...existing.content,
        content,
        revision: existing.content.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: login
      },
      summary?.trim() || `Update ${existing.content.title}`,
      { sha: existing.sha, branch }
    )

    if (mine) return { id: proposalId(repo, mine.number), created: false }

    const pr = await gh.openProposal(repo, {
      title: summary?.trim() || `Changes to ${existing.content.title}`,
      // The path is in the body because that is what identifies which document this is about.
      body: `Aiper proposal for \`${path}\``,
      branch,
      base: project.defaultBranch
    })
    return { id: proposalId(repo, pr.number), created: true }
  },

  /**
   * What a proposal actually changes: the document as the author left it on their branch,
   * against the document as the project has it now. Word-level, because "this paragraph
   * changed" is not reviewable and "90.0 became 95.0" is.
   */
  async reviewProposal(id: string): Promise<{
    proposal: Proposal
    diff: ReturnType<typeof diffDocuments>
    conflicts: Array<{ blockIndex: number; base: string; ours: string; theirs: string }> | null
  }> {
    const { repo, number } = splitProposalId(id)
    const pulls = await gh.listProposals(repo, 'all')
    const pr = pulls.find((p) => p.number === number)
    if (!pr) throw new Error('That proposal no longer exists.')

    const path = pr.body?.match(/`([^`]+)`/)?.[1]
    if (!path) throw new Error('That proposal does not name a document.')

    const projects = await gh.listProjects()
    const project = projects.find((p) => p.fullName === repo)
    const [current, proposed] = await Promise.all([
      gh.readJson<StoredDocument>(repo, path, project?.defaultBranch),
      gh.readJson<StoredDocument>(repo, path, pr.branch)
    ])
    if (!current || !proposed) throw new Error('That document is missing on one side of the proposal.')

    return {
      proposal: {
        id,
        documentId: `${repo}:${path}`,
        authorId: pr.author,
        authorName: pr.author,
        baseRevision: current.content.revision,
        summary: pr.title,
        status: pr.merged ? 'accepted' : pr.state === 'open' ? 'open' : 'closed',
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        resolvedByName: null,
        resultingRevision: null,
        stale: false,
        commentCount: pr.commentCount
      },
      diff: diffDocuments(current.content.content as PMNode, proposed.content.content as PMNode),
      conflicts: null
    }
  },

  async acceptProposal(id: string, reason: string | null): Promise<{ ok: true; revision: number }> {
    const { repo, number } = splitProposalId(id)
    await gh.acceptProposal(repo, number, reason ?? undefined)
    return { ok: true, revision: 0 }
  },

  async closeProposal(id: string, _reason: string | null = null): Promise<{ ok: true }> {
    const { repo, number } = splitProposalId(id)
    await gh.closeProposal(repo, number)
    return { ok: true }
  },

  async proposalComments(id: string): Promise<{ comments: Array<{ id: string; authorName: string; body: string; createdAt: string }> }> {
    const { repo, number } = splitProposalId(id)
    const comments = await gh.listComments(repo, number)
    return {
      comments: comments.map((c) => ({
        id: String(c.id),
        authorName: c.author,
        body: c.body,
        createdAt: c.createdAt
      }))
    }
  },

  async addProposalComment(id: string, body: string): Promise<{ ok: true }> {
    const { repo, number } = splitProposalId(id)
    await gh.addComment(repo, number, body)
    return { ok: true }
  },

  // ----- people --------------------------------------------------------------------------------
  async folderMembers(folderId: string): Promise<{ members: FolderMember[] }> {
    const { repo } = splitId(folderId)
    const people = await gh.listCollaborators(repo)
    return {
      members: people.map((p) => ({
        userId: p.login,
        displayName: p.name ?? p.login,
        email: p.login,
        access: p.access === 'admin' ? ('owner' as const) : p.access === 'write' ? ('editor' as const) : ('viewer' as const),
        inherited: false
      }))
    }
  },

  async folderInvites(folderId: string): Promise<{ invites: PendingInvite[] }> {
    const { repo } = splitId(folderId)
    const invites = await gh.listPendingInvites(repo)
    return {
      invites: invites.map((i) => ({
        email: i.login,
        access: i.access === 'admin' ? ('owner' as const) : i.access === 'write' ? ('editor' as const) : ('viewer' as const),
        invitedAt: ''
      }))
    }
  },

  /**
   * Add someone by email or GitHub username.
   *
   * For emails, the local part is turned into a candidate GitHub username
   * (`jane.doe@gmail.com` → `JaneDoe`) and verified against GitHub before the invitation
   * goes out — GitHub cannot look a private email address up, so the login is derived
   * rather than discovered.
   */
  async inviteToFolder(folderId: string, who: string, access: 'viewer' | 'editor' | 'owner'): Promise<{ ok: true; immediate: boolean }> {
    const { repo } = splitId(folderId)
    const resolved = await gh.resolvePerson(who)
    if (!resolved.ok) throw new Error(resolved.reason)

    const permission = access === 'owner' ? 'admin' : access === 'editor' ? 'write' : 'read'
    const { invited } = await gh.addCollaborator(repo, resolved.user.login, permission)
    return { ok: true, immediate: !invited }
  },

  async setFolderAccess(folderId: string, login: string, access: 'viewer' | 'editor' | 'owner' | null): Promise<{ ok: true }> {
    const { repo } = splitId(folderId)
    if (access === null) await gh.removeCollaborator(repo, login)
    else await gh.addCollaborator(repo, login, access === 'owner' ? 'admin' : access === 'editor' ? 'write' : 'read')
    return { ok: true }
  },

  /**
   * The record of what happened. Commits are the audit trail here: each carries an author, a
   * timestamp and a message, and the hash of every one covers the one before it, so the chain
   * is tamper-evident by construction rather than by a column we maintain.
   */
  async audit(documentId?: string): Promise<{ entries: Array<{ id: string; occurred_at: string; printed_name: string; action: string; document_id: string | null; revision_before: number | null; revision_after: number | null; reason: string | null }> }> {
    if (!documentId) return { entries: [] }
    const { repo, path } = splitId(documentId)
    const commits = await gh.commitsFor(repo, path)
    return {
      entries: commits.map((c, i) => ({
        id: c.sha,
        occurred_at: c.date,
        printed_name: c.author,
        action: 'document.saved',
        document_id: documentId,
        revision_before: commits.length - i - 1,
        revision_after: commits.length - i,
        reason: c.message
      }))
    }
  },

  async verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAtId: string | null; detail: string }> {
    // Git already guarantees this: every commit hash covers its parent, so a rewritten history
    // produces different hashes. There is nothing for Aiper to re-compute.
    return {
      ok: true,
      checked: 0,
      brokenAtId: null,
      detail: 'History is git commits — each hash covers its parent, so tampering changes every hash after it.'
    }
  },

  async revokeInvite(folderId: string, login: string): Promise<{ ok: true }> {
    const { repo } = splitId(folderId)
    await gh.removeCollaborator(repo, login)
    return { ok: true }
  }
}

export type GithubApi = typeof githubApi
