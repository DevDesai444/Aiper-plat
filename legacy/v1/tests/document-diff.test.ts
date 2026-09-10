import { diffDocuments, mergeDocuments, type PMNode } from '../src/shared/diff'

const para = (text: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const heading = (text: string): PMNode => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] })

const BASE: PMNode = {
  type: 'doc',
  content: [
    heading('3.2.P.5 Control of Drug Product'),
    para('The assay acceptance criterion is 90.0-110.0% of the label claim.'),
    para('Dissolution testing is performed using USP Apparatus 5.'),
    para('This paragraph is untouched by everyone.')
  ]
}

// Riya tightens the assay range and leaves everything else alone.
const RIYA: PMNode = {
  type: 'doc',
  content: [
    heading('3.2.P.5 Control of Drug Product'),
    para('The assay acceptance criterion is 95.0-105.0% of the label claim.'),
    para('Dissolution testing is performed using USP Apparatus 5.'),
    para('This paragraph is untouched by everyone.')
  ]
}

// Arjun corrects the apparatus number and adds a sentence — a different paragraph.
const ARJUN: PMNode = {
  type: 'doc',
  content: [
    heading('3.2.P.5 Control of Drug Product'),
    para('The assay acceptance criterion is 90.0-110.0% of the label claim.'),
    para('Dissolution testing is performed using USP Apparatus 2.'),
    para('This paragraph is untouched by everyone.'),
    para('Related substances are controlled per ICH Q3B.')
  ]
}

// Sara edits the SAME sentence as Riya — a genuine conflict.
const SARA: PMNode = {
  type: 'doc',
  content: [
    heading('3.2.P.5 Control of Drug Product'),
    para('The assay acceptance criterion is 85.0-115.0% of the label claim.'),
    para('Dissolution testing is performed using USP Apparatus 5.'),
    para('This paragraph is untouched by everyone.')
  ]
}

function renderWords(words: Array<{ kind: string; text: string }>): string {
  return words
    .map((w) => (w.kind === 'added' ? `[+${w.text}]` : w.kind === 'removed' ? `[-${w.text}]` : w.text))
    .join('')
}

function show(label: string, from: PMNode, to: PMNode): void {
  console.log(`\n=== ${label} ===`)
  const d = diffDocuments(from, to)
  for (const b of d.blocks) {
    if (b.status === 'unchanged') continue
    console.log(`  ${b.status.padEnd(9)} ${renderWords(b.words)}`)
  }
  console.log(
    `  summary: +${d.summary.wordsAdded} words / -${d.summary.wordsRemoved} words, ` +
      `${d.summary.modified} modified, ${d.summary.added} added, ${d.summary.removed} removed`
  )
}

show("Riya's proposal", BASE, RIYA)
show("Arjun's proposal", BASE, ARJUN)

console.log('\n=== MERGE: Riya + Arjun (different paragraphs — should combine cleanly) ===')
const clean = mergeDocuments(BASE, RIYA, ARJUN)
for (const b of clean.merged.content ?? []) {
  console.log('  ', (b.content?.[0]?.text ?? '').slice(0, 78))
}
console.log('  conflicts:', clean.conflicts.length)

console.log('\n=== MERGE: Riya + Sara (same sentence — must refuse to guess) ===')
const clash = mergeDocuments(BASE, RIYA, SARA)
console.log('  conflicts:', clash.conflicts.length)
for (const c of clash.conflicts) {
  console.log(`    block ${c.blockIndex}`)
  console.log(`      base : ${c.base}`)
  console.log(`      ours : ${c.ours}`)
  console.log(`      theirs: ${c.theirs}`)
}

const ok =
  clean.conflicts.length === 0 &&
  (clean.merged.content ?? []).length === 5 &&
  clash.conflicts.length === 1
console.log(ok ? '\nALL PASS' : '\nFAILED')
process.exit(ok ? 0 : 1)
