/**
 * Human phrases for the audit `action` codes E1–E7 (and later E9) write.
 * The label is a verb phrase — "renamed a document", "granted access" —
 * so the row reads naturally as "<Alice> <label> <when>".
 *
 * Enumerated codes come from the server's writeAudit call sites
 * (apps/server/src/routes/hierarchy/writes/*.ts + save flow + comments +
 * permissions/invitations); unknown codes fall through to
 * `humanizeAction` which slugifies the raw string into something readable
 * so a new action a peer engineer adds doesn't render as raw JSON.
 */

const LABELS: Record<string, string> = {
  // Documents
  'document.created': 'created a document',
  'document.renamed': 'renamed a document',
  'document.moved': 'moved a document',
  'document.archived': 'archived a document',
  'document.unarchived': 'restored a document',
  'document.deleted': 'deleted a document',
  'document.saved': 'saved a checkpoint',
  // Snapshots (in case E3 audits Save under this code)
  'snapshot.saved': 'saved a checkpoint',

  // Folders
  'folder.created': 'created a folder',
  'folder.renamed': 'renamed a folder',
  'folder.moved': 'moved a folder',
  'folder.archived': 'archived a folder',
  'folder.unarchived': 'restored a folder',
  'folder.deleted': 'deleted a folder',

  // Projects (no delete route today — kept out of the map)
  'project.created': 'created the project',
  'project.renamed': 'renamed the project',
  'project.moved': 'moved the project',
  'project.archived': 'archived the project',
  'project.unarchived': 'restored the project',

  // Access
  'permission.granted': 'granted access',
  'permission.revoked': 'revoked access',
  'invitation.sent': 'sent an invitation',
  'invitation.revoked': 'revoked an invitation',

  // Comments
  'comment.added': 'added a comment',
  'comment.deleted': 'deleted a comment',
  'comment.resolved': 'resolved a comment',

  // Product tree (E9 territory; future-proof entries so the page reads
  // right the moment E3/E9 start writing these codes).
  'product-node.created': 'added a product-tree node',
  'product-node.renamed': 'renamed a product-tree node',
  'product-node.moved': 'moved a product-tree node',
  'product-node.deleted': 'deleted a product-tree node',
  'product-node.linked': 'linked a product-tree node to a document',
  'product-node.unlinked': 'unlinked a product-tree node from a document',
}

/**
 * Turn any audit action code into a readable phrase. Known codes get the
 * hand-authored label above; unknown codes get a slugify pass so a new
 * action from a peer shows up as "some new thing" rather than raw JSON.
 */
export function labelForAction(action: string): string {
  const known = LABELS[action]
  if (known) return known
  return humanizeAction(action)
}

/**
 * Fallback formatter for unknown codes. Splits on `.`, converts remaining
 * separators to spaces, and returns a rough "verb-phrased" form of the
 * event — e.g. `product-node.linked` → "linked a product node". Not
 * perfect, but readable, and it flags to the user that they are looking
 * at a real event even if the label has not been curated yet.
 */
function humanizeAction(action: string): string {
  const [subject, verb, ...rest] = action.split('.')
  const verbAll = [verb, ...rest].filter(Boolean).join(' ')
  const subj = (subject ?? action).replace(/[-_]/g, ' ')
  if (!verbAll) return subj || action
  return `${verbAll.replace(/[-_]/g, ' ')} a ${subj}`
}
