import { FolderInput, GitBranch, AlertTriangle } from 'lucide-react'
import { useImportStore } from '../store/importStore'
import { useSessionStore } from '../store/sessionStore'

/**
 * Confirmation for bringing a folder in as a project.
 *
 * Shown before anything is created. Importing writes a private repository to someone's GitHub
 * account, so the counts, the destination and — most of all — whether this will create a new
 * repository or adopt one that already exists have to be visible beforehand, not reported
 * afterwards.
 */
export default function ImportProjectDialog(): React.JSX.Element | null {
  const plan = useImportStore((s) => s.plan)
  const problems = useImportStore((s) => s.problems)
  const progress = useImportStore((s) => s.progress)
  const error = useImportStore((s) => s.error)
  const confirm = useImportStore((s) => s.confirm)
  const cancel = useImportStore((s) => s.cancel)
  const user = useSessionStore((s) => s.user)

  if (!plan && !progress && !error) return null

  const running = progress !== null && progress.phase !== 'done'
  const docxCount = plan?.files.filter((f) => f.isDocx).length ?? 0
  const otherCount = (plan?.files.length ?? 0) - docxCount

  return (
    <div className="import-backdrop">
      <div className="import-dialog">
        <div className="import-dialog-head">
          <FolderInput size={16} strokeWidth={1.5} />
          <h2>{plan ? `Import “${plan.projectName}”` : 'Importing'}</h2>
        </div>

        {error && (
          <div className="import-error">
            <AlertTriangle size={13} strokeWidth={1.5} />
            <span>{error}</span>
          </div>
        )}

        {plan && !running && (
          <>
            {plan.target.mode === 'adopt' ? (
              <div className="import-note">
                <GitBranch size={13} strokeWidth={1.5} />
                <span>
                  This folder is already shared, so it will simply be connected — nothing is copied and no
                  second workspace is created.
                </span>
              </div>
            ) : (
              <div className="import-summary">
                <p>
                  All <strong>{plan.files.length} files</strong> will be brought in, folder structure intact.
                </p>
                <ul>
                  {docxCount > 0 && (
                    <li>
                      {docxCount} Word document{docxCount === 1 ? '' : 's'} — kept as they are, plus an editable
                      copy for Aiper
                    </li>
                  )}
                  {otherCount > 0 && (
                    <li>
                      {otherCount} other file{otherCount === 1 ? '' : 's'} (PDFs, spreadsheets, images) — kept
                      unchanged
                    </li>
                  )}
                </ul>
                <p className="import-fineprint">
                  Originals are always kept, because converting a Word file for editing drops tracked changes,
                  comments and headers. Nothing is discarded.
                </p>
              </div>
            )}

            {problems.map((p) => (
              <div key={p} className="import-note import-note--warn">
                <AlertTriangle size={13} strokeWidth={1.5} />
                <span>{p}</span>
              </div>
            ))}
          </>
        )}

        {running && progress && (
          <div className="import-progress">
            <div className="import-progress-state">
              {progress.phase === 'uploading'
                ? `Uploading ${progress.done} of ${progress.total}`
                : progress.phase === 'committing'
                  ? 'Creating the import commit'
                  : 'Reading the folder'}
            </div>
            <div className="import-progress-file">
              {progress.phase === 'uploading' || progress.phase === 'committing' || progress.phase === 'scanning'
                ? progress.message
                : ''}
            </div>
            <div className="import-progress-bar">
              <div
                className="import-progress-bar-fill"
                style={{
                  width:
                    progress.phase === 'uploading' ? `${Math.round((progress.done / progress.total) * 100)}%` : '100%'
                }}
              />
            </div>
          </div>
        )}

        <div className="import-actions">
          <button type="button" onClick={cancel} disabled={running}>
            {error && !running ? 'Close' : 'Cancel'}
          </button>
          {plan && (
            <button
              type="button"
              className="is-primary"
              disabled={running || problems.length > 0}
              onClick={() => void confirm(user?.displayName ?? 'unknown')}
            >
              {/* After a failure the same button retries, because retrying *is* the recovery. */}
              {error ? 'Try again' : plan.target.mode === 'adopt' ? 'Connect' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
