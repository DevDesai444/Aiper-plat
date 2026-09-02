import { session } from 'electron'

/**
 * Content-Security-Policy for the renderer.
 *
 * Sent as a header rather than the `<meta>` tag it replaces. A meta policy only governs what
 * comes after it in the document, and Vite injects its dev preamble above it, so the tag
 * silently failed to cover the very thing a strict policy exists for.
 *
 * The only host the app talks to is GitHub. There is no Aiper server, so there is no address
 * to configure and nothing else to allow.
 */
const GITHUB = 'https://api.github.com https://github.com https://avatars.githubusercontent.com'

function cspFor(): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  const devSources = dev ? ` ${dev} ${dev.replace(/^http/, 'ws')}` : ''

  // `@vitejs/plugin-react` injects an inline Fast Refresh preamble, so the dev renderer cannot
  // run under a strict script-src. The packaged app has no preamble and keeps the strict
  // policy, which is the one that matters.
  const scriptSrc = dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    // No plugins. Chromium's PDF viewer is one, and it refuses to load under any CSP at all —
    // so PDFs are drawn with PDF.js on a canvas instead, and nothing here needs object-src.
    "object-src 'none'",
    // PDF.js's worker, served from the app's own origin; blob: covers its fallback path.
    "worker-src 'self' blob:",
    // Only for previewing a plain-text file held in a project.
    "frame-src 'self' blob:",
    `connect-src 'self' ${GITHUB}${devSources}`
  ].join('; ')
}

export function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspFor()]
      }
    })
  })
}
