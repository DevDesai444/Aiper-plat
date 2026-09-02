import { useEffect, useRef, useState } from 'react'

/**
 * Render a PDF with PDF.js instead of Chromium's built-in viewer.
 *
 * The built-in viewer is a plugin, and plugins are governed by `object-src`. Under this app's
 * content-security policy it refuses to load — verified across every combination: the scheme
 * named explicitly, `object-src *`, an <iframe> rather than an <embed>. It renders only with
 * no CSP at all, and weakening the policy of a regulatory document app to display a file is
 * not a trade worth making. The failure mode is silent, too: a blank grey box and nothing in
 * the console unless you go looking for the violation.
 *
 * PDF.js draws to a canvas, so none of that applies. It also means the pages render
 * identically on macOS and Windows, which the plugin does not guarantee.
 */

/** Rendered eagerly rather than on scroll. A CTD section is tens of pages, not hundreds, and
 *  virtualising would cost more complexity than it saves here. */
const MAX_PAGES = 200

interface Props {
  /** The PDF's bytes. */
  data: Uint8Array
  /** Shown if the file turns out not to be a readable PDF. */
  onError: (message: string) => void
}

export default function PdfCanvas({ data, onError }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pageCount, setPageCount] = useState(0)
  const [rendered, setRendered] = useState(0)

  useEffect(() => {
    let cancelled = false
    let doc: { numPages: number; destroy: () => Promise<void> } | null = null

    void (async () => {
      const container = containerRef.current
      if (!container) return
      container.innerHTML = ''

      try {
        const pdfjs = await import('pdfjs-dist')
        // Vite resolves this to a real asset URL served from the app's own origin, so the
        // worker needs no CSP allowance beyond 'self'.
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

        // PDF.js takes ownership of the buffer it is given and detaches it, so a copy goes in
        // — otherwise a re-render of the same file gets an empty array.
        const task = pdfjs.getDocument({ data: data.slice() })
        const loaded = await task.promise
        if (cancelled) {
          void loaded.destroy()
          return
        }
        doc = loaded
        setPageCount(loaded.numPages)

        const total = Math.min(loaded.numPages, MAX_PAGES)
        for (let n = 1; n <= total; n++) {
          if (cancelled) return
          const page = await loaded.getPage(n)
          // Rendered at twice the CSS size so the text is not soft on a retina display.
          const viewport = page.getViewport({ scale: 2 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className = 'pdf-page'
          const context = canvas.getContext('2d')
          if (!context) continue
          await page.render({ canvasContext: context, viewport }).promise
          if (cancelled) return
          container.appendChild(canvas)
          setRendered(n)
        }
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'That PDF could not be read.')
      }
    })()

    return () => {
      cancelled = true
      void doc?.destroy()
    }
  }, [data, onError])

  return (
    <div className="pdf-scroll">
      {pageCount > 0 && rendered < Math.min(pageCount, MAX_PAGES) && (
        <div className="pdf-status">
          Rendering page {rendered + 1} of {Math.min(pageCount, MAX_PAGES)}…
        </div>
      )}
      {pageCount > MAX_PAGES && (
        <div className="pdf-status">
          Showing the first {MAX_PAGES} of {pageCount} pages.
        </div>
      )}
      <div ref={containerRef} className="pdf-pages" />
    </div>
  )
}
