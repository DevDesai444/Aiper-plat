/**
 * The two Content-Security-Policies must name the same hosts.
 *
 * The browser intersects the `<meta>` policy in index.html with the header the main process
 * sends, so a host missing from either one is blocked however permissive the other is. That
 * failed exactly once, silently: index.html was reverted to a version naming a server that no
 * longer existed, sign-in succeeded, and then the first call to api.github.com was refused with
 * nothing but "Failed to fetch" in the UI.
 *
 * Cheap to check, and it fails at the point the mistake is made rather than at sign-in.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
const settings = readFileSync(join(root, 'src/main/ipc/settings.ts'), 'utf8')

const failures: string[] = []
const check = (label: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? '  ok ' : '  ✗  '} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const meta = html.match(/content="([^"]*Content-Security|[^"]*connect-src[^"]*)"/)?.[1] ?? ''
check('index.html declares a connect-src', meta.includes('connect-src'), meta ? 'found' : 'MISSING')

// Everything the app actually talks to.
for (const host of ['https://api.github.com', 'https://github.com']) {
  check(`index.html allows ${host}`, meta.includes(host))
  check(`settings.ts allows ${host}`, settings.includes(host))
}

// The dev server, or the renderer cannot load its own modules or reach HMR.
check('index.html allows the Vite dev server', meta.includes('http://localhost:5173'))

// PDFs are drawn by PDF.js on a canvas, not by Chromium's plugin — that plugin refuses to
// load under any CSP whatsoever, which was verified against object-src *, a named scheme and
// an <iframe> before giving up on it. So plugins stay off, and the worker is what has to be
// allowed instead.
for (const [label, src] of [['index.html', meta], ['settings.ts', settings]] as const) {
  check(`${label} forbids plugins outright`, /object-src\s+'none'/.test(src))
  check(`${label} allows the PDF.js worker`, /worker-src[^;"]*'self'/.test(src))
}

// Nothing may still reference the retired Aiper server.
for (const dead of ['%VITE_AIPER_HOST%', '127.0.0.1:8787', '8787']) {
  check(`index.html no longer references ${dead}`, !meta.includes(dead))
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
