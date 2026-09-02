/**
 * The rule set the Compliance tab reports against, mirroring the ids the built-in example
 * provider emits (src/main/services/compliance/stub/StubComplianceProvider.ts).
 *
 * Kept in the renderer so the Rulebook button can describe a finding's rule without a round
 * trip. When a real compliance engine is connected this should be fetched from it instead.
 */
export interface Rule {
  id: string
  title: string
  tier: 'verified' | 'corroborated' | 'advisory'
}

export const RULEBOOK: Rule[] = [
  { id: 'CMC-114', title: 'Assay acceptance criteria must agree across 3.2.P.5 sections', tier: 'verified' },
  { id: 'CMC-201', title: 'Shelf-life claims require supporting stability justification', tier: 'verified' },
  { id: 'CMC-088', title: 'Related-substance limits must cite the analytical method', tier: 'corroborated' },
  { id: 'CMC-142', title: 'Registration batch size must be stated explicitly', tier: 'corroborated' },
  { id: 'STY-004', title: 'Table captions follow the CTD caption convention', tier: 'advisory' },
  { id: 'STY-011', title: 'Cross-reference stability data from formulation sections', tier: 'advisory' }
]

export const RULEBOOK_VERSION = 'v4.2'
