import { query, queryOne, transaction } from './db.js'
import { writeAudit } from './audit.js'
import { contentHash } from './documents.js'
import { diffDocuments, mergeDocuments, type PMNode, type DocumentDiff } from '../../src/shared/diff.js'
import { accessForDocument, atLeast } from './folders.js'
import type { SessionUser } from './auth.js'

export type ProposalStatus = 'open' | 'accepted' | 'closed'

export interface ProposalSummary {
  id: string
  documentId: string
  authorId: string
  authorName: string
  baseRevision: number
  summary: string | null
  status: ProposalStatus
  createdAt: string
  updatedAt: string
  resolvedByName: string | null
  resultingRevision: number | null
  /** True when the document has moved on since this was written. */
  stale: boolean
  commentCount: number
}

interface ProposalRow {
  id: string
  document_id: string
  author_id: string
  display_name: string
  base_revision: number
  summary: string | null
  status: ProposalStatus
  created_at: Date
  updated_at: Date
  resolved_by_name: string | null
  resulting_revision: number | null
  current_revision: number
  comment_count: string
}

function toSummary(r: ProposalRow): ProposalSummary {
  return {
    id: r.id,
    documentId: r.document_id,
    authorId: r.author_id,
    authorName: r.display_name,
    baseRevision: r.base_revision,
    summary: r.summary,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    resolvedByName: r.resolved_by_name,
    resultingRevision: r.resulting_revision,
    stale: r.status === 'open' && r.base_revision !== r.current_revision,
    commentCount: Number(r.comment_count)
  }
}

const SELECT_PROPOSAL = `
  SELECT p.id, p.document_id, p.author_id, u.display_name, p.base_revision, p.summary,
         p.status, p.created_at, p.updated_at, p.resulting_revision,
         ru.display_name AS resolved_by_name,
         d.current_revision,
         (SELECT count(*) FROM proposal_comments c WHERE c.proposal_id = p.id) AS comment_count
    FROM proposals p
    JOIN users u ON u.id = p.author_id
    JOIN documents d ON d.id = p.document_id
    LEFT JOIN users ru ON ru.id = p.resolved_by`

export async function listProposals(documentId: string): Promise<ProposalSummary[]> {
  const rows = await query<ProposalRow>(
    `${SELECT_PROPOSAL} WHERE p.document_id = $1 ORDER BY (p.status = 'open') DESC, p.updated_at DESC`,
    [documentId]
  )
  return rows.map(toSummary)
}

export async function getProposal(id: string): Promise<(ProposalSummary & { content: PMNode }) | null> {
  const row = await queryOne<ProposalRow & { content: PMNode }>(
    `${SELECT_PROPOSAL.replace('SELECT p.id,', 'SELECT p.content, p.id,')} WHERE p.id = $1`,
    [id]
  )
  if (!row) return null
  return { ...toSummary(row), content: row.content }
}

/**
 * Create or update the author's open proposal. Saving repeatedly updates the same proposal
 * rather than creating a new one, so a reviewer sees one entry per author.
 */
export async function saveProposal(
  user: SessionUser,
  documentId: string,
  content: PMNode,
  summary: string | null
): Promise<{ id: string; created: boolean }> {
  return transaction(async (client) => {
    const doc = await client.query<{ current_revision: number }>(
      'SELECT current_revision FROM documents WHERE id = $1',
      [documentId]
    )
    if (doc.rowCount === 0) throw new Error('No such document')
    const base = doc.rows[0].current_revision

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM proposals WHERE document_id = $1 AND author_id = $2 AND status = 'open'",
      [documentId, user.id]
    )

    if (existing.rowCount) {
      const id = existing.rows[0].id
      await client.query(
        `UPDATE proposals SET content = $2, content_hash = $3, summary = COALESCE($4, summary),
                              updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(content), contentHash(content), summary]
      )
      await writeAudit(
        { userId: user.id, printedName: user.displayName, action: 'proposal.updated', documentId },
        client
      )
      return { id, created: false }
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO proposals (document_id, author_id, base_revision, content, content_hash, summary)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [documentId, user.id, base, JSON.stringify(content), contentHash(content), summary]
    )
    await writeAudit(
      {
        userId: user.id,
        printedName: user.displayName,
        action: 'proposal.opened',
        documentId,
        revisionBefore: base
      },
      client
    )
    return { id: inserted.rows[0].id, created: true }
  })
}

export interface ProposalReview {
  proposal: ProposalSummary
  diff: DocumentDiff
  /** Populated only when the proposal is stale: does it still apply over the newer content? */
  conflicts: Array<{ blockIndex: number; base: string; ours: string; theirs: string }> | null
}

/** Diff of a proposal against the document as it stands right now. */
export async function reviewProposal(id: string): Promise<ProposalReview | null> {
  const proposal = await getProposal(id)
  if (!proposal) return null

  const current = await queryOne<{ content: PMNode }>(
    'SELECT content FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1',
    [proposal.documentId]
  )
  const diff = diffDocuments(current?.content ?? null, proposal.content)

  // If the document moved on after this was written, check whether the proposal still applies
  // over the newer content. Blocks both sides touched are reported, not guessed at.
  let conflicts: ProposalReview['conflicts'] = null
  if (proposal.stale) {
    const baseRev = await queryOne<{ content: PMNode }>(
      'SELECT content FROM document_revisions WHERE document_id = $1 AND revision = $2',
      [proposal.documentId, proposal.baseRevision]
    )
    if (baseRev && current) {
      conflicts = mergeDocuments(baseRev.content, proposal.content, current.content).conflicts
    }
  }

  return { proposal, diff, conflicts }
}

export type ResolveOutcome =
  | { ok: true; revision?: number }
  | { ok: false; error: string }

/** Accept a proposal: its content becomes the next revision of the document. */
export async function acceptProposal(user: SessionUser, id: string, reason: string | null): Promise<ResolveOutcome> {
  const proposal = await getProposal(id)
  if (!proposal) return { ok: false, error: 'No such proposal.' }
  if (proposal.status !== 'open') return { ok: false, error: 'This proposal has already been resolved.' }

  // Only an owner of the project may accept. Authors cannot
  // approve their own work into the record without owner rights.
  if (!atLeast(await accessForDocument(user.id, proposal.documentId), 'owner')) {
    return { ok: false, error: 'You need owner access on this folder to accept a proposal.' }
  }

  return transaction(async (client) => {
    const doc = await client.query<{ current_revision: number }>(
      'SELECT current_revision FROM documents WHERE id = $1 FOR UPDATE',
      [proposal.documentId]
    )
    const current = doc.rows[0].current_revision
    const next = current + 1

    const full = await client.query<{ page_setup: unknown; header: unknown; footer: unknown }>(
      'SELECT page_setup, header, footer FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1',
      [proposal.documentId]
    )

    await client.query(
      `INSERT INTO document_revisions
         (document_id, revision, parent_revision, content, content_hash, page_setup, header, footer, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        proposal.documentId,
        next,
        current,
        JSON.stringify(proposal.content),
        contentHash(proposal.content),
        JSON.stringify(full.rows[0]?.page_setup ?? {}),
        full.rows[0]?.header ? JSON.stringify(full.rows[0].header) : null,
        full.rows[0]?.footer ? JSON.stringify(full.rows[0].footer) : null,
        // Authorship stays with the person who wrote the change, not the approver.
        proposal.authorId
      ]
    )
    await client.query('UPDATE documents SET current_revision = $2 WHERE id = $1', [proposal.documentId, next])
    await client.query(
      `UPDATE proposals SET status = 'accepted', resolved_at = now(), resolved_by = $2,
                            resolution_reason = $3, resulting_revision = $4 WHERE id = $1`,
      [id, user.id, reason, next]
    )
    await writeAudit(
      {
        userId: user.id,
        printedName: user.displayName,
        action: 'proposal.accepted',
        documentId: proposal.documentId,
        revisionBefore: current,
        revisionAfter: next,
        newValue: { proposalId: id, author: proposal.authorName },
        reason
      },
      client
    )
    return { ok: true as const, revision: next }
  })
}

/** Close a proposal without applying it. The author may close their own; owners may close any. */
export async function closeProposal(user: SessionUser, id: string, reason: string | null): Promise<ResolveOutcome> {
  const proposal = await getProposal(id)
  if (!proposal) return { ok: false, error: 'No such proposal.' }
  if (proposal.status !== 'open') return { ok: false, error: 'This proposal has already been resolved.' }

  const isAuthor = proposal.authorId === user.id
  const isOwner = atLeast(await accessForDocument(user.id, proposal.documentId), 'owner')
  if (!isAuthor && !isOwner) return { ok: false, error: 'Only the author or a folder owner can close this.' }

  await query(
    `UPDATE proposals SET status = 'closed', resolved_at = now(), resolved_by = $2, resolution_reason = $3
      WHERE id = $1`,
    [id, user.id, reason]
  )
  await writeAudit({
    userId: user.id,
    printedName: user.displayName,
    action: 'proposal.closed',
    documentId: proposal.documentId,
    newValue: { proposalId: id, author: proposal.authorName },
    reason
  })
  return { ok: true }
}

export interface ProposalComment {
  id: string
  authorName: string
  body: string
  createdAt: string
}

export async function listProposalComments(proposalId: string): Promise<ProposalComment[]> {
  const rows = await query<{ id: string; display_name: string; body: string; created_at: Date }>(
    `SELECT c.id, u.display_name, c.body, c.created_at
       FROM proposal_comments c JOIN users u ON u.id = c.author_id
      WHERE c.proposal_id = $1 ORDER BY c.created_at`,
    [proposalId]
  )
  return rows.map((r) => ({
    id: r.id,
    authorName: r.display_name,
    body: r.body,
    createdAt: r.created_at.toISOString()
  }))
}

export async function addProposalComment(user: SessionUser, proposalId: string, body: string): Promise<void> {
  const proposal = await getProposal(proposalId)
  if (!proposal) throw new Error('No such proposal')
  await query('INSERT INTO proposal_comments (proposal_id, author_id, body) VALUES ($1,$2,$3)', [
    proposalId,
    user.id,
    body
  ])
  await writeAudit({
    userId: user.id,
    printedName: user.displayName,
    action: 'proposal.commented',
    documentId: proposal.documentId,
    newValue: { proposalId }
  })
}
