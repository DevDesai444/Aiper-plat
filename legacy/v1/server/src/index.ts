import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { z } from 'zod'
import { login, logout, resolveSession, changePassword, type SessionUser } from './auth.js'
import { isConfigured as githubConfigured, startDeviceFlow, pollDeviceFlow } from './github-auth.js'
import {
  listDocuments,
  createDocument,
  getDocument,
  saveRevision,
  acquireLock,
  releaseLock,
  heartbeatLock,
  documentHistory,
  listComments,
  addComment,
  resolveComment,
  deleteComment
} from './documents.js'
import { writeAudit, verifyAuditChain } from './audit.js'
import {
  folderTreeFor,
  createFolder,
  folderMembers,
  setFolderAccess,
  effectiveAccess,
  accessForDocument,
  atLeast,
  folderInvites,
  inviteEmail,
  revokeInvite
} from './folders.js'
import {
  listProposals,
  getProposal,
  saveProposal,
  reviewProposal,
  acceptProposal,
  closeProposal,
  listProposalComments,
  addProposalComment
} from './proposals.js'
import { query } from './db.js'

const PORT = Number(process.env.PORT ?? 8787)
const app = Fastify({ logger: { level: 'warn' } })

await app.register(cors, { origin: true, credentials: true })
await app.register(websocket)

// ------------------------------------------------------------------ realtime broadcast
type Client = { socket: { send: (data: string) => void }; user: SessionUser }
const clients = new Set<Client>()

/**
 * Push an event to connected clients.
 *
 * Scoped by access when the payload names a document or folder: a live event carries the
 * document id and who touched it, which is exactly the metadata someone with no access should
 * not receive. Presence and other unscoped events still go to everyone.
 *
 * Fire-and-forget — callers do not await the fan-out, and one bad socket cannot hold up a
 * request.
 */
export function broadcast(event: string, payload: unknown, exceptUserId?: string): void {
  const message = JSON.stringify({ event, payload })
  const scope = (payload as { documentId?: string } | undefined)?.documentId

  void (async () => {
    for (const c of [...clients]) {
      if (exceptUserId && c.user.id === exceptUserId) continue
      if (scope) {
        // The id may name a document or a folder depending on the event, so allow either.
        const viaDoc = await accessForDocument(c.user.id, scope).catch(() => null)
        const viaFolder = viaDoc ? null : await effectiveAccess(c.user.id, scope).catch(() => null)
        if (!viaDoc && !viaFolder) continue
      }
      try {
        c.socket.send(message)
      } catch {
        clients.delete(c)
      }
    }
  })()
}

// ------------------------------------------------------------------------- auth helper
function bearer(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers['authorization']
  if (typeof raw !== 'string') return undefined
  return raw.startsWith('Bearer ') ? raw.slice(7) : undefined
}

async function requireUser(req: never, reply: never): Promise<SessionUser | null> {
  const r = req as unknown as { headers: Record<string, unknown> }
  const user = await resolveSession(bearer(r))
  if (!user) {
    ;(reply as unknown as { code: (n: number) => { send: (b: unknown) => void } })
      .code(401)
      .send({ error: 'Not signed in' })
    return null
  }
  return user
}

// -------------------------------------------------------------------------------- auth
app.post('/api/auth/login', async (req, reply) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'Email and password are required.' })
  const result = await login(body.data.email, body.data.password, String(req.headers['user-agent'] ?? ''))
  if (!result.ok) return reply.code(401).send({ error: result.error })
  return { token: result.token, user: result.user, passwordExpired: result.passwordExpired }
})

/** Which sign-in methods this server actually offers, so the client never shows a dead button. */
app.get('/api/auth/methods', async () => ({ github: githubConfigured(), password: true }))

app.post('/api/auth/github/start', async (_req, reply) => {
  if (!githubConfigured()) return reply.code(501).send({ error: 'GitHub sign-in is not configured on this server.' })
  try {
    return await startDeviceFlow()
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach GitHub.' })
  }
})

app.post('/api/auth/github/poll', async (req, reply) => {
  if (!githubConfigured()) return reply.code(501).send({ error: 'GitHub sign-in is not configured on this server.' })
  const body = z.object({ deviceCode: z.string().min(1) }).safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'deviceCode is required.' })
  try {
    return await pollDeviceFlow(body.data.deviceCode, String(req.headers['user-agent'] ?? ''))
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : 'Sign-in failed.' })
  }
})

app.post('/api/auth/logout', async (req, reply) => {
  const user = await resolveSession(bearer(req as never))
  await logout(bearer(req as never), user)
  return reply.send({ ok: true })
})

app.get('/api/auth/me', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  return { user }
})

app.post('/api/auth/change-password', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const body = z.object({ current: z.string(), next: z.string() }).safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'Both passwords are required.' })
  const problem = await changePassword(user, body.data.current, body.data.next)
  if (problem) return reply.code(400).send({ error: problem })
  return { ok: true }
})

// ----------------------------------------------------------------------------- folders
app.get('/api/folders', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  return { folders: await folderTreeFor(user) }
})

app.post('/api/folders', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const body = z.object({ name: z.string().min(1), parentId: z.string().uuid().nullable() }).safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'name and parentId are required.' })
  const result = await createFolder(user, body.data.name, body.data.parentId)
  if ('error' in result) return reply.code(403).send(result)
  broadcast('documents:changed', { reason: 'folder-created', documentId: result.id })
  return result
})

app.get('/api/folders/:id/members', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await effectiveAccess(user.id, id), 'viewer')) {
    return reply.code(403).send({ error: 'No access to this folder.' })
  }
  return { members: await folderMembers(id) }
})

app.post('/api/folders/:id/members', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const body = z
    .object({ userId: z.string().uuid(), access: z.enum(['viewer', 'editor', 'owner']).nullable() })
    .safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'userId and access are required.' })
  const problem = await setFolderAccess(user, id, body.data.userId, body.data.access)
  if (problem) return reply.code(403).send({ error: problem })
  broadcast('documents:changed', { reason: 'permissions-changed', documentId: id })
  return { ok: true }
})

/** Pending invitations: email addresses added to this project that have not signed in yet. */
app.get('/api/folders/:id/invites', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await effectiveAccess(user.id, id), 'viewer')) {
    return reply.code(403).send({ error: 'No access to this project.' })
  }
  return { invites: await folderInvites(id) }
})

/** Add someone by email. They do not need an Aiper account — see folders.inviteEmail. */
app.post('/api/folders/:id/invites', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const body = z
    .object({ email: z.string().min(3), access: z.enum(['viewer', 'editor', 'owner']) })
    .safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'An email address and an access level are required.' })
  const result = await inviteEmail(user, id, body.data.email, body.data.access)
  if (!result.ok) return reply.code(403).send({ error: result.error })
  broadcast('documents:changed', { reason: 'permissions-changed', documentId: id })
  return result
})

app.delete('/api/folders/:id/invites/:email', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id, email } = req.params as { id: string; email: string }
  const problem = await revokeInvite(user, id, decodeURIComponent(email))
  if (problem) return reply.code(403).send({ error: problem })
  return { ok: true }
})

// --------------------------------------------------------------------------- documents
app.get('/api/documents', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  return { documents: await listDocuments(user) }
})

app.post('/api/documents', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const body = z
    .object({ path: z.string().min(1), title: z.string().min(1), folderId: z.string().uuid() })
    .safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'path, title and folderId are required.' })
  if (!atLeast(await effectiveAccess(user.id, body.data.folderId), 'editor')) {
    return reply.code(403).send({ error: 'You have read-only access to this folder.' })
  }
  const doc = await createDocument(user, body.data.path, body.data.title, body.data.folderId)
  broadcast('documents:changed', { reason: 'created', documentId: doc.id })
  return { document: doc }
})

app.get('/api/documents/:id', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  const rev = (req.query as { revision?: string }).revision
  const doc = await getDocument(id, rev ? Number(rev) : undefined)
  if (!doc) return reply.code(404).send({ error: 'No such document' })
  await writeAudit({ userId: user.id, printedName: user.displayName, action: 'document.opened', documentId: id })
  return { document: doc }
})

app.get('/api/documents/:id/history', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  return { history: await documentHistory(id) }
})

app.post('/api/documents/:id/save', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  // Folder access decides who may write here, not the global role.
  if (!atLeast(await accessForDocument(user.id, id), 'editor')) {
    return reply.code(403).send({ error: 'You have read-only access to this folder.' })
  }
  const body = z
    .object({
      baseRevision: z.number().int().nonnegative(),
      content: z.unknown(),
      pageSetup: z.unknown().optional(),
      header: z.unknown().optional(),
      footer: z.unknown().optional(),
      reason: z.string().optional()
    })
    .safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'Malformed save payload.' })

  const outcome = await saveRevision(
    user,
    id,
    body.data.baseRevision,
    {
      content: body.data.content,
      pageSetup: body.data.pageSetup ?? {},
      header: body.data.header ?? null,
      footer: body.data.footer ?? null
    },
    body.data.reason
  )
  if (!outcome.ok) return reply.code(409).send(outcome)

  broadcast('document:updated', {
    documentId: id,
    revision: outcome.revision,
    savedBy: user.displayName,
    savedByUserId: user.id,
    savedAt: new Date().toISOString()
  })
  return outcome
})

// -------------------------------------------------------------------------------- locks
app.post('/api/documents/:id/lock', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'editor')) {
    return reply.code(403).send({ error: 'You have read-only access to this folder.' })
  }
  const result = await acquireLock(user, id)
  if (!result.ok) return reply.code(409).send(result)
  broadcast('lock:changed', { documentId: id, lockedBy: user.displayName, lockedByUserId: user.id })
  return result
})

app.post('/api/documents/:id/unlock', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const force = Boolean((req.body as { force?: boolean } | undefined)?.force)
  if (force && !atLeast(await accessForDocument(user.id, id), 'owner')) {
    return reply.code(403).send({ error: 'Only an owner of this project can force a check-in.' })
  }
  await releaseLock(user, id, force)
  broadcast('lock:changed', { documentId: id, lockedBy: null, lockedByUserId: null })
  return { ok: true }
})

app.post('/api/documents/:id/heartbeat', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  return { held: await heartbeatLock(user, id) }
})

// ----------------------------------------------------------------------------- comments
app.get('/api/documents/:id/comments', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  return { comments: await listComments(id) }
})

app.post('/api/documents/:id/comments', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'editor')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  const body = z
    .object({ markId: z.string().min(1), quotedText: z.string(), body: z.string().min(1) })
    .safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'markId, quotedText and body are required.' })
  await addComment(user, id, body.data.markId, body.data.quotedText, body.data.body)
  broadcast('comments:changed', { documentId: id }, user.id)
  return { ok: true }
})

app.post('/api/documents/:id/comments/:markId/resolve', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id, markId } = req.params as { id: string; markId: string }
  if (!atLeast(await accessForDocument(user.id, id), 'editor')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  await resolveComment(user, id, markId)
  broadcast('comments:changed', { documentId: id }, user.id)
  return { ok: true }
})

app.delete('/api/documents/:id/comments/:markId', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id, markId } = req.params as { id: string; markId: string }
  if (!atLeast(await accessForDocument(user.id, id), 'editor')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  await deleteComment(user, id, markId)
  broadcast('comments:changed', { documentId: id }, user.id)
  return { ok: true }
})

// --------------------------------------------------------------------------- proposals
app.get('/api/documents/:id/proposals', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  return { proposals: await listProposals(id) }
})

app.post('/api/documents/:id/proposals', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  if (!atLeast(await accessForDocument(user.id, id), 'editor')) {
    return reply.code(403).send({ error: 'You have read-only access to this folder.' })
  }
  const body = z.object({ content: z.unknown(), summary: z.string().nullable().optional() }).safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'content is required.' })
  const result = await saveProposal(user, id, body.data.content as never, body.data.summary ?? null)
  broadcast('proposals:changed', { documentId: id, proposalId: result.id, by: user.displayName })
  return result
})

app.get('/api/proposals/:id/review', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const review = await reviewProposal(id)
  if (!review) return reply.code(404).send({ error: 'No such proposal.' })
  if (!atLeast(await accessForDocument(user.id, review.proposal.documentId), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  return review
})

app.post('/api/proposals/:id/accept', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const reason = (req.body as { reason?: string } | undefined)?.reason ?? null
  const result = await acceptProposal(user, id, reason)
  if (!result.ok) return reply.code(403).send(result)
  const p = await getProposal(id)
  if (p) {
    broadcast('document:updated', {
      documentId: p.documentId,
      revision: result.revision ?? 0,
      savedBy: user.displayName,
      savedByUserId: user.id,
      savedAt: new Date().toISOString()
    })
    broadcast('proposals:changed', { documentId: p.documentId, proposalId: id, by: user.displayName })
  }
  return result
})

app.post('/api/proposals/:id/close', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const reason = (req.body as { reason?: string } | undefined)?.reason ?? null
  const p = await getProposal(id)
  const result = await closeProposal(user, id, reason)
  if (!result.ok) return reply.code(403).send(result)
  if (p) broadcast('proposals:changed', { documentId: p.documentId, proposalId: id, by: user.displayName })
  return result
})

app.get('/api/proposals/:id/comments', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const p = await getProposal(id)
  if (!p) return reply.code(404).send({ error: 'No such proposal.' })
  if (!atLeast(await accessForDocument(user.id, p.documentId), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  return { comments: await listProposalComments(id) }
})

app.post('/api/proposals/:id/comments', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { id } = req.params as { id: string }
  const body = z.object({ body: z.string().min(1) }).safeParse(req.body)
  if (!body.success) return reply.code(400).send({ error: 'body is required.' })
  const target = await getProposal(id)
  if (!target) return reply.code(404).send({ error: 'No such proposal.' })
  if (!atLeast(await accessForDocument(user.id, target.documentId), 'viewer')) {
    return reply.code(403).send({ error: 'You do not have access to this document.' })
  }
  await addProposalComment(user, id, body.data.body)
  const p = target
  if (p) broadcast('proposals:changed', { documentId: p.documentId, proposalId: id, by: user.displayName })
  return { ok: true }
})

// -------------------------------------------------------------------------------- audit
app.get('/api/audit', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  const { documentId, limit } = req.query as { documentId?: string; limit?: string }
  const cap = Math.min(Number(limit ?? 200) || 200, 1000)

  if (documentId) {
    if (!atLeast(await accessForDocument(user.id, documentId), 'viewer')) {
      return reply.code(403).send({ error: 'You do not have access to this document.' })
    }
    return {
      entries: await query(
        `SELECT id, occurred_at, printed_name, action, document_id, revision_before, revision_after, reason
           FROM audit_log WHERE document_id = $1 ORDER BY id DESC LIMIT ${cap}`,
        [documentId]
      )
    }
  }

  // No document asked for: everything you can reach, plus your own actions. There is no
  // administrator, so nobody gets a view of the whole estate.
  return {
    entries: await query(
      `SELECT a.id, a.occurred_at, a.printed_name, a.action, a.document_id,
              a.revision_before, a.revision_after, a.reason
         FROM audit_log a
         LEFT JOIN documents d ON d.id = a.document_id
        WHERE a.user_id = $1
           OR (d.folder_id IS NOT NULL AND aiper_effective_access($1, d.folder_id) IS NOT NULL)
        ORDER BY a.id DESC LIMIT ${cap}`,
      [user.id]
    )
  }
})

app.get('/api/audit/verify', async (req, reply) => {
  const user = await requireUser(req as never, reply as never)
  if (!user) return
  return await verifyAuditChain()
})

// ----------------------------------------------------------------------------- realtime
app.get('/ws', { websocket: true }, async (socket, req) => {
  const token = (req.query as { token?: string }).token
  const user = await resolveSession(token)
  if (!user) {
    socket.close(4001, 'Not signed in')
    return
  }
  const client: Client = { socket: socket as unknown as Client['socket'], user }
  clients.add(client)
  broadcast('presence:changed', { userId: user.id, displayName: user.displayName, online: true })
  socket.on('close', () => {
    clients.delete(client)
    broadcast('presence:changed', { userId: user.id, displayName: user.displayName, online: false })
  })
})

app.get('/api/health', async () => ({ ok: true, service: 'aiper-server' }))

// Loopback by default so the server is not exposed unintentionally. Set HOST=0.0.0.0 to let
// other machines on the network connect — see scripts/serve-lan.sh.
const HOST = process.env.HOST ?? '127.0.0.1'
await app.listen({ port: PORT, host: HOST })
console.log(`Aiper server listening on http://${HOST}:${PORT}`)
if (HOST === '0.0.0.0') {
  console.log('Reachable from other machines on this network. Traffic is NOT encrypted —')
  console.log('acceptable for an internal demo, not for real submission records.')
}
