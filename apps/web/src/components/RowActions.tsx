import { useState } from 'react'
import type { AiperRole } from '@aiper/shared/types'
import { RowActionsMenu, type RowAction } from './RowActionsMenu'
import { RenameDialog } from './RenameDialog'
import { MoveDialog } from './MoveDialog'
import { ConfirmDialog } from './ConfirmDialog'
import {
  deleteDocument,
  deleteFolder,
  moveDocument,
  moveFolder,
  renameDocument,
  renameFolder,
} from '../api/endpoints'

type SubjectType = 'document' | 'folder'
type CurrentParent = { kind: 'root' } | { kind: 'folder'; folderId: string }

/**
 * Per-row rename / move / delete actions for a document or folder. Renders
 * the `⋯` menu and hosts the three dialogs the actions open.
 *
 * Role gates match the server (routes/hierarchy/writes/{documents,folders}.ts):
 *   rename → editor+
 *   move   → owner
 *   delete → owner
 *
 * Actions the caller cannot perform are omitted from the menu; a row with
 * no available actions renders no menu at all (`<RowActionsMenu>` handles
 * the empty case), so hosts pass this unconditionally without an outer
 * role-check wrapper.
 *
 * `onChanged` is invoked after any successful mutation; pages typically
 * refetch their list from that callback.
 */
export function RowActions({
  subjectType,
  subjectId,
  subjectLabel,
  role,
  projectId,
  currentParent,
  onChanged,
}: {
  subjectType: SubjectType
  subjectId: string
  subjectLabel: string
  role: AiperRole | null
  projectId: string
  /** Where the subject currently sits — enables/disables the same target in
   *  the move picker. Documents at a project root pass `{ kind: 'root' }`
   *  and folders at a project root pass `{ kind: 'root' }`. */
  currentParent: CurrentParent
  onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState<null | 'rename' | 'move' | 'delete'>(null)

  const canRename = role === 'editor' || role === 'owner'
  const canMoveOrDelete = role === 'owner'

  const actions: RowAction[] = []
  if (canRename) actions.push({ label: 'Rename', onSelect: () => setOpen('rename') })
  if (canMoveOrDelete) {
    actions.push({ label: 'Move…', onSelect: () => setOpen('move') })
    actions.push({ label: 'Delete', onSelect: () => setOpen('delete'), danger: true })
  }

  const noun = subjectType

  return (
    <>
      <RowActionsMenu actions={actions} label={`Actions for ${subjectLabel}`} />

      {open === 'rename' && (
        <RenameDialog
          title={`Rename ${noun}`}
          subjectLabel={subjectLabel}
          initial={subjectLabel}
          fieldLabel={subjectType === 'folder' ? 'Name' : 'Title'}
          onSave={async (next) => {
            if (subjectType === 'folder') await renameFolder(subjectId, next)
            else await renameDocument(subjectId, next)
            await onChanged()
          }}
          onClose={() => setOpen(null)}
        />
      )}

      {open === 'move' && (
        <MoveDialog
          subjectType={subjectType}
          subjectLabel={subjectLabel}
          projectId={projectId}
          currentFolderId={subjectType === 'folder' ? subjectId : undefined}
          currentParent={currentParent}
          onMove={async (target) => {
            if (subjectType === 'folder') {
              await moveFolder(
                subjectId,
                target.kind === 'root' ? null : target.folderId,
              )
            } else {
              await moveDocument(
                subjectId,
                target.kind === 'root'
                  ? { projectId }
                  : { folderId: target.folderId },
              )
            }
            await onChanged()
          }}
          onClose={() => setOpen(null)}
        />
      )}

      {open === 'delete' && (
        <ConfirmDialog
          title={`Delete ${noun}?`}
          confirmLabel={`Delete ${noun}`}
          danger
          message={
            subjectType === 'folder' ? (
              <>
                Delete <strong>{subjectLabel}</strong>? This also deletes every
                folder, document, and comment inside it. This cannot be undone.
              </>
            ) : (
              <>
                Delete <strong>{subjectLabel}</strong>? Its save history and
                comments are removed with it. This cannot be undone.
              </>
            )
          }
          onConfirm={async () => {
            if (subjectType === 'folder') await deleteFolder(subjectId)
            else await deleteDocument(subjectId)
            await onChanged()
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
