/**
 * The compliance client against a stand-in engine.
 *
 * Two things are worth pinning down here. The mapping, because it is where the engine's
 * careful distinction between *how a finding was reached* and *how far it can be stood
 * behind* could quietly collapse — and a panel that shows a model's guess with the same
 * weight as a recomputed number is worse than one that shows nothing.
 *
 * And the failure paths, because the whole reason this provider exists is that the engine is
 * a separate process someone has to remember to start. "Engine not running" has to arrive as
 * something a user can act on, not a stack trace or, worse, an empty findings list that reads
 * as a clean document.
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpComplianceProvider } from '../src/main/services/compliance/http/HttpComplianceProvider'
import { formatLocation, formatRuleId, mapReport, type WireFault } from '../src/main/services/compliance/http/faultMapping'

const failures: string[] = []
const check = (label: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? '  ok ' : '  ✗  '} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const fault = (over: Partial<WireFault> = {}): WireFault => ({
  title: 'Assay criterion inconsistent with 3.2.P.5.1',
  detail: 'States 90.0-110.0% while the specification table lists 85.0-115.0%.',
  category: 'spec_mismatch',
  severity: 'high',
  tier: 'verified',
  evidence_class: 'code_verified',
  confidence: 0.91,
  evidence: 'Assay: 90.0 - 110.0%',
  section: '3.2.P.5.1',
  page: 4,
  source: 'oracle:result_vs_limit',
  guidance_refs: ['ICH Q6A'],
  precedents: [{ anda_number: 'A0912' }, { anda_number: 'A1140' }],
  ...over
})

// ---------------------------------------------------------------- mapping
console.log('\n=== Fault → Finding mapping ===')
{
  const result = mapReport('doc-1', { faults: [fault()], analysis_seconds: 41.2, domains_checked: ['specification'] })
  const [f] = result.findings

  check('severity and tier survive intact', f.severity === 'high' && f.tier === 'verified')
  check('evidence_class becomes a detection method', f.detectionMethod === 'code-verified', f.detectionMethod)
  check('the verbatim span is carried', f.evidence === 'Assay: 90.0 - 110.0%')
  check('precedents are counted', f.precedentCount === 2, String(f.precedentCount))
  check('the result is labelled as engine output', result.engine === 'http')
  check('analysis time is carried', result.analysedInSeconds === 41.2)
  check('domains are carried', result.domainsChecked?.[0] === 'specification')
}

{
  // `checklist` is deterministic like a recomputation but reaches its conclusion differently.
  // Folding it into code-verified would tell a reviewer a required element was *measured*.
  const [f] = mapReport('d', { faults: [fault({ evidence_class: 'checklist' })] }).findings
  check('checklist stays distinct from code-verified', f.detectionMethod === 'checklist', f.detectionMethod)
}

{
  const [f] = mapReport('d', { faults: [fault({ evidence_class: 'model_judgment', tier: 'advisory' })] }).findings
  check('model judgment is not dressed up', f.detectionMethod === 'model-judgment' && f.tier === 'advisory')
}

{
  // An engine newer than this client must not have its findings quietly downgraded out of
  // sight, nor promoted above what it claimed.
  const [f] = mapReport('d', { faults: [fault({ severity: 'catastrophic', tier: 'proven' })] }).findings
  check('an unknown severity falls back to medium, not low', f.severity === 'medium', f.severity)
  check('an unknown tier falls back to advisory', f.tier === 'advisory', f.tier)
}

{
  const withGuidance = formatRuleId(fault())
  const withoutGuidance = formatRuleId(fault({ guidance_refs: [] }))
  check('a guidance reference is preferred as the rule', withGuidance === 'ICH Q6A', withGuidance)
  check('the category stands in when there is none', withoutGuidance === 'spec_mismatch', withoutGuidance)
}

{
  check('location composes section, page and table', formatLocation(fault()) === '3.2.P.5.1 · p.4')
  // A DOCX with no real pagination reports page 0; "p.0" would be a confident-looking lie.
  check('a zero page is omitted rather than printed', formatLocation(fault({ page: 0 })) === '3.2.P.5.1')
  check('an empty location degrades to a dash', formatLocation({}) === '—')
}

{
  const report = mapReport('d', {
    faults: [
      fault({ title: 'low advisory', severity: 'low', tier: 'advisory' }),
      fault({ title: 'high verified', severity: 'high', tier: 'verified' }),
      fault({ title: 'high advisory', severity: 'high', tier: 'advisory' })
    ]
  })
  check(
    'findings are ordered by severity then tier',
    report.findings.map((f) => f.title).join(' | ') === 'high verified | high advisory | low advisory',
    report.findings.map((f) => f.title).join(' | ')
  )
  check('severity counts add up', report.severityCounts.high === 2 && report.severityCounts.low === 1)
}

// ---------------------------------------------------------------- transport
console.log('\n=== Transport against a stand-in engine ===')

const docPath = join(mkdtempSync(join(tmpdir(), 'aiper-compliance-')), 'spec.docx')
writeFileSync(docPath, Buffer.from('PK not really a docx, the stand-in does not parse it'))

interface Route {
  status?: number
  body: unknown
}

async function withEngine(routes: Record<string, Route | ((n: number) => Route)>, run: (base: string) => Promise<void>) {
  const hits: Record<string, number> = {}
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const key = Object.keys(routes).find((r) => path.startsWith(r))
    if (!key) {
      res.writeHead(404).end('{}')
      return
    }
    hits[key] = (hits[key] ?? 0) + 1
    const route = routes[key]
    const resolved = typeof route === 'function' ? route(hits[key]) : route
    res.writeHead(resolved.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(resolved.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

await withEngine(
  {
    '/api/analyze': { body: { job_id: 'job1', status: 'accepted' } },
    // Two polls before completing, so the phase reporting is actually exercised.
    '/api/results/': (n: number) =>
      n < 2
        ? { body: { job_id: 'job1', status: 'detecting' } }
        : {
            body: {
              job_id: 'job1',
              status: 'complete',
              faults: { faults: [fault()], analysis_seconds: 12.5, domains_checked: ['specification'] }
            }
          }
  },
  async (base) => {
    const provider = new HttpComplianceProvider(() => base, () => '')
    const phases: string[] = []
    const result = await provider.checkDocument('doc-1', docPath, {
      onProgress: (u) => phases.push(u.state)
    })
    check('a completed job returns its findings', result.findings.length === 1)
    check('the run is attributed to the engine', result.engine === 'http')
    check('progress reports upload then detection', phases.includes('uploading') && phases.includes('detecting'), phases.join(' → '))
  }
)

await withEngine(
  { '/health': { body: { environment: 'local', llm: 'up', data_store: 'sqlite' } } },
  async (base) => {
    const status = await new HttpComplianceProvider(() => base, () => '').status()
    check('health reports the environment', status.reachable && status.environment === 'local')
  }
)

await withEngine(
  {
    '/api/analyze': { body: { job_id: 'job2', status: 'accepted' } },
    '/api/results/': { body: { job_id: 'job2', status: 'error', error: 'Parsing failed: encrypted document' } }
  },
  async (base) => {
    const provider = new HttpComplianceProvider(() => base, () => '')
    let message = ''
    await provider.checkDocument('doc-1', docPath).catch((e: Error) => {
      message = e.message
    })
    // A failed job must not surface as zero findings — that reads as a clean document.
    check('a failed job raises the engine reason', message.includes('encrypted document'), message)
  }
)

await withEngine(
  { '/api/analyze': { status: 400, body: { detail: 'Only PDF and DOCX files are accepted.' } } },
  async (base) => {
    const provider = new HttpComplianceProvider(() => base, () => '')
    let message = ''
    await provider.checkDocument('doc-1', docPath).catch((e: Error) => {
      message = e.message
    })
    check('a rejection keeps the engine wording', message === 'Only PDF and DOCX files are accepted.', message)
  }
)

{
  // Nothing listening: the case that happens every time someone forgets `make api`.
  const provider = new HttpComplianceProvider(() => 'http://127.0.0.1:1', () => '')
  const status = await provider.status()
  check('an unreachable engine is reported, not thrown', !status.reachable && Boolean(status.error), status.error)
  check('the address is named so it can be fixed', status.baseUrl === 'http://127.0.0.1:1')

  const roster = await provider.listModels()
  check('a missing model roster degrades to empty', roster.models.length === 0)
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
if (failures.length > 0) process.exit(1)
