import { useEffect, useState } from 'react'
import { FileWarning, ShieldCheck } from 'lucide-react'
import { readBlob } from '../github/client'
import PdfCanvas from './PdfCanvas'
import { useComplianceStore } from '../store/complianceStore'
import { useUiStore } from '../store/uiStore'

/**
 * Show a file that lives in a project but cannot be edited — chiefly the PDFs a submission is
 * mostly made of.
 *
 * They were listed in the tree with nowhere to open, so a project could show fifty PDFs and
 * let you read none of them. The bytes are fetched from the project and rendered in-process:
 * PDFs by PDF.js on a canvas (see PdfCanvas for why not Chromium's viewer), images and text
 * as ordinary resources. Nothing is written to disk and nothing is fetched from a remote
 * origin.
 */
const PREVIEWABLE: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  txt: 'text/plain'
}

export function previewMimeFor(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return PREVIEWABLE[ext] ?? null
}

export default function FileViewer(): React.JSX.Element {
  const preview = useUiStore((s) => s.previewFile)
  const setDock = useUiStore((s) => s.setDock)
  const checkProjectFile = useComplianceStore((s) => s.checkProjectFile)

  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!preview) return
    const mime = previewMimeFor(preview.name)
    if (!mime) return

    let cancelled = false
    let created: string | null = null

    void (async () => {
      setError(null)
      setBytes(null)
      setObjectUrl(null)
      try {
        const base64 = await readBlob(preview.projectFullName, preview.sha)
        const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        if (cancelled) return
        if (mime === 'application/pdf') {
          setBytes(raw)
          return
        }
        // Images and text are ordinary resources, not plugin content, so a blob: URL is fine
        // for them — img-src already allows it.
        created = URL.createObjectURL(new Blob([raw], { type: mime }))
        setObjectUrl(created)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'That file could not be opened.')
      }
    })()

    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [preview])

  if (!preview) {
    return <div className="navigator-empty">No file selected</div>
  }

  const mime = previewMimeFor(preview.name)
  const checkable = /\.(pdf|docx)$/i.test(preview.name)

  return (
    <div className="file-viewer">
      <div className="file-viewer-bar">
        <span className="file-viewer-name" title={preview.path}>
          {preview.name}
        </span>
        {checkable && (
          <button
            type="button"
            className="compliance-action"
            onClick={() => {
              setDock('compliance', { open: true })
              void checkProjectFile(preview.projectFullName, preview)
            }}
          >
            <ShieldCheck size={12} strokeWidth={1.5} /> Check compliance
          </button>
        )}
      </div>

      {error ? (
        <div className="file-viewer-empty">
          <FileWarning size={20} strokeWidth={1.5} />
          <p>{error}</p>
        </div>
      ) : !mime ? (
        <div className="file-viewer-empty">
          <FileWarning size={20} strokeWidth={1.5} />
          <p>{preview.name} is stored in this project, but Aiper cannot display this type.</p>
          <p className="navigator-empty-hint">
            It is kept exactly as it was imported, and a compliance check can still read it.
          </p>
        </div>
      ) : mime === 'application/pdf' ? (
        bytes ? (
          <PdfCanvas data={bytes} onError={setError} />
        ) : (
          <div className="file-viewer-empty">
            <p>Opening {preview.name}…</p>
          </div>
        )
      ) : !objectUrl ? (
        <div className="file-viewer-empty">
          <p>Opening {preview.name}…</p>
        </div>
      ) : mime.startsWith('image/') ? (
        <div className="file-viewer-image">
          <img src={objectUrl} alt={preview.name} />
        </div>
      ) : (
        <iframe className="file-viewer-embed" src={objectUrl} title={preview.name} />
      )}
    </div>
  )
}
