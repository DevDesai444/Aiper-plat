/**
 * Translation between the engine's wire types and Aiper's.
 *
 * Kept apart from the transport so it can be tested without a server, and so the one place
 * that decides how a `Fault` is presented to a reviewer is a set of pure functions rather
 * than something buried in a response handler.
 *
 * The engine's vocabulary is deliberately more precise than a UI needs — it distinguishes
 * how a finding was reached (`evidence_class`) from how far it can be stood behind (`tier`).
 * Both are carried across intact: collapsing them here would leave the panel unable to tell
 * a recomputed number from a model's opinion, which is the distinction the whole tiering
 * scheme exists to preserve.
 */
import type {
  ConfidenceTier,
  DetectionMethod,
  DocumentComplianceResult,
  Finding,
  Severity
} from '../ComplianceProvider'

/** `schemas.faults.Fault` as it arrives over the wire. */
export interface WireFault {
  title?: string
  detail?: string
  category?: string
  severity?: string
  tier?: string
  evidence_class?: string
  confidence?: number
  evidence?: string
  section?: string
  page?: number
  table_ref?: string
  source?: string
  guidance_refs?: string[]
  precedents?: unknown[]
  novel?: boolean
  out_of_distribution?: boolean
  challenge_note?: string
}

/** `schemas.faults.FaultReport`. */
export interface WireFaultReport {
  job_id?: string
  faults?: WireFault[]
  faults_found?: boolean
  domains_checked?: string[]
  analysis_seconds?: number
}

const SEVERITIES: Severity[] = ['high', 'medium', 'low']
const TIERS: ConfidenceTier[] = ['verified', 'corroborated', 'advisory']

const EVIDENCE_CLASS_TO_METHOD: Record<string, DetectionMethod> = {
  code_verified: 'code-verified',
  checklist: 'checklist',
  quote_anchored: 'quote-anchored',
  model_judgment: 'model-judgment'
}

/**
 * An unrecognised value means the engine is ahead of this client. Defaulting a severity
 * *down* would hide a finding the engine rated urgent, so unknown severities and tiers both
 * resolve to the most cautious reading: worth a look, not yet corroborated.
 */
function toSeverity(raw: string | undefined): Severity {
  return SEVERITIES.includes(raw as Severity) ? (raw as Severity) : 'medium'
}

function toTier(raw: string | undefined): ConfidenceTier {
  return TIERS.includes(raw as ConfidenceTier) ? (raw as ConfidenceTier) : 'advisory'
}

function toDetectionMethod(raw: string | undefined): DetectionMethod {
  return EVIDENCE_CLASS_TO_METHOD[raw ?? ''] ?? 'model-judgment'
}

/**
 * Where the reviewer should look. The engine reports section, page and table separately and
 * any of them may be missing, so this composes whichever are present rather than emitting a
 * confident-looking "p.0" for a document with no real pagination.
 */
export function formatLocation(fault: WireFault): string {
  const parts: string[] = []
  if (fault.section?.trim()) parts.push(fault.section.trim())
  if (typeof fault.page === 'number' && fault.page > 0) parts.push(`p.${fault.page}`)
  if (fault.table_ref?.trim()) parts.push(fault.table_ref.trim())
  return parts.join(' · ') || '—'
}

/**
 * What to print as the rule. A guidance reference ("ICH Q6A") is what a reviewer recognises
 * and can look up; the engine's `source` ("specialist:impurities") names the agent that
 * raised it, which is provenance rather than a rule. Prefer the former, fall back to the
 * category, and keep `source` in its own field either way.
 */
export function formatRuleId(fault: WireFault): string {
  const guidance = fault.guidance_refs?.find((ref) => ref?.trim())
  if (guidance) return guidance.trim()
  if (fault.category?.trim()) return fault.category.trim()
  return fault.source?.trim() || 'uncategorised'
}

export function mapFault(fault: WireFault, index: number): Finding {
  return {
    id: `f${index}`,
    severity: toSeverity(fault.severity),
    tier: toTier(fault.tier),
    title: fault.title?.trim() || 'Untitled finding',
    detail: fault.detail?.trim() ?? '',
    ruleId: formatRuleId(fault),
    location: formatLocation(fault),
    detectionMethod: toDetectionMethod(fault.evidence_class),
    precedentCount: fault.precedents?.length ?? 0,
    evidence: fault.evidence?.trim() || undefined,
    category: fault.category,
    confidence: fault.confidence,
    source: fault.source,
    guidanceRefs: fault.guidance_refs?.length ? fault.guidance_refs : undefined,
    challengeNote: fault.challenge_note?.trim() || undefined,
    novel: fault.novel || undefined,
    section: fault.section?.trim() || undefined,
    page: typeof fault.page === 'number' && fault.page > 0 ? fault.page : undefined
  }
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const TIER_ORDER: Record<ConfidenceTier, number> = { verified: 0, corroborated: 1, advisory: 2 }

export function mapReport(
  docId: string,
  report: WireFaultReport,
  options: { modelUsed?: string } = {}
): DocumentComplianceResult {
  const findings = (report.faults ?? []).map(mapFault)

  // Verified-and-high first. The engine already sorts, but it is the panel that a reviewer
  // reads top-down, and a resort here costs nothing and survives an engine that does not.
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      (b.confidence ?? 0) - (a.confidence ?? 0)
  )

  return {
    docId,
    findings,
    severityCounts: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length
    },
    analysedInSeconds: report.analysis_seconds ?? 0,
    engine: 'http',
    modelUsed: options.modelUsed,
    domainsChecked: report.domains_checked?.length ? report.domains_checked : undefined
  }
}
