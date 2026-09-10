/**
 * Custom pino serializers wired into the Fastify logger config.
 *
 * The one we need is `req`: Fastify emits an "incoming request" and a
 * "request completed" line at info level for every hit, both carrying
 * `req.url`. The WS upgrade for /ws carries the Supabase JWT in the
 * query string (browsers cannot set Authorization on a WebSocket), so
 * the default serialiser would write the token verbatim into the log
 * store. This serialiser redacts the `token` query parameter so the
 * bearer never survives the log line.
 *
 * The redaction is unconditional — no route other than /ws expects
 * `token=` today, and doing it globally keeps a future misuse of
 * `token` on another route from tripping the same leak.
 */

/**
 * Minimum shape the pino req serialiser sees. Pino calls this with the
 * raw request; Fastify's own req is a superset. Keeping the input type
 * narrow lets the unit test call the serialiser without constructing
 * a full FastifyRequest.
 */
export interface LoggableReq {
  method?: string
  url?: string
  hostname?: string
  ip?: string
  socket?: { remotePort?: number }
}

/**
 * Redact `token=` from a URL's query string. Leaves the rest of the
 * query intact so a log reader can still tell which document a WS
 * upgrade was for.
 */
export function redactTokenInUrl(url: string): string {
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return url
  const path = url.slice(0, qIdx)
  const params = new URLSearchParams(url.slice(qIdx + 1))
  if (!params.has('token')) return url
  params.set('token', 'REDACTED')
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/**
 * Pino req serialiser used in the Fastify logger config. Mirrors the
 * default Fastify serializer output (method, url, hostname, remoteAddress,
 * remotePort) but with the URL run through redactTokenInUrl first.
 */
export function reqSerializer(req: LoggableReq): {
  method: string | undefined
  url: string
  hostname: string | undefined
  remoteAddress: string | undefined
  remotePort: number | undefined
} {
  const rawUrl = typeof req.url === 'string' ? req.url : ''
  return {
    method: req.method,
    url: redactTokenInUrl(rawUrl),
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }
}
