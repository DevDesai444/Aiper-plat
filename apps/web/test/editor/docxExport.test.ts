import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  buildDocxBlob,
  buildDocxBytes,
  slugifyForDocxFilename,
  type PMNode,
} from '../../src/editor/docxExport'

/**
 * Unzip a .docx byte stream and return the parts we care about: the
 * primary document body (word/document.xml) and the numbering config
 * (word/numbering.xml, when present). The full zip is a lot, but every
 * assertion in this file lives in one of those two files.
 *
 * We inspect the raw bytes rather than the Blob because jsdom's Blob
 * implementation in this vitest version does not expose
 * `arrayBuffer()`. `buildDocxBytes` shares its work with
 * `buildDocxBlob` (the Blob is just a wrapper over the same bytes),
 * so we're testing the same wire representation.
 */
async function inspectDocxBytes(bytes: Uint8Array): Promise<{
  document: string
  numbering: string | null
  files: string[]
}> {
  const zip = await JSZip.loadAsync(bytes)
  const files = Object.keys(zip.files).sort()
  const doc = zip.file('word/document.xml')
  const num = zip.file('word/numbering.xml')
  if (!doc) throw new Error('word/document.xml missing from docx bytes')
  return {
    document: await doc.async('text'),
    numbering: num ? await num.async('text') : null,
    files,
  }
}

async function inspect(json: PMNode, title: string): Promise<{
  document: string
  numbering: string | null
  files: string[]
}> {
  const bytes = await buildDocxBytes(json, title)
  return inspectDocxBytes(bytes)
}

/**
 * ProseMirror JSON fixture builders. Small helpers keep the actual
 * `it()` bodies focussed on the assertion, not on nested JSON literals.
 */
function docOf(...blocks: PMNode[]): PMNode {
  return { type: 'doc', content: blocks }
}
function paragraph(...inline: PMNode[]): PMNode {
  return { type: 'paragraph', content: inline }
}
function text(t: string, ...markTypes: string[]): PMNode {
  return {
    type: 'text',
    text: t,
    marks: markTypes.length ? markTypes.map((m) => ({ type: m })) : undefined,
  }
}
function heading(level: number, ...inline: PMNode[]): PMNode {
  return { type: 'heading', attrs: { level }, content: inline }
}
function bulletList(...items: PMNode[]): PMNode {
  return { type: 'bulletList', content: items }
}
function orderedList(...items: PMNode[]): PMNode {
  return { type: 'orderedList', content: items }
}
function listItem(...blocks: PMNode[]): PMNode {
  return { type: 'listItem', content: blocks }
}
function blockquote(...blocks: PMNode[]): PMNode {
  return { type: 'blockquote', content: blocks }
}
function codeBlock(t: string): PMNode {
  return { type: 'codeBlock', content: [text(t)] }
}
function hardBreak(): PMNode {
  return { type: 'hardBreak' }
}
function hr(): PMNode {
  return { type: 'horizontalRule' }
}

describe('buildDocxBlob', () => {
  it('produces a non-empty .docx for a simple document', async () => {
    const json = docOf(paragraph(text('Hello satellite editor')))
    const bytes = await buildDocxBytes(json, 'Report')
    expect(bytes.length).toBeGreaterThan(500) // even the smallest .docx is well over this
    // buildDocxBlob wraps the same bytes with the OOXML MIME. Sizes are
    // NOT compared across separate calls — docx embeds a build timestamp
    // in the zip, so two packings of the same doc differ by a few bytes.
    const blob = await buildDocxBlob(json, 'Report')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(500)
    expect(blob.type).toContain('wordprocessingml.document')
    const { document: xml, files } = await inspectDocxBytes(bytes)
    expect(files).toContain('word/document.xml')
    expect(files).toContain('[Content_Types].xml')
    expect(xml).toContain('Hello satellite editor')
  })

  it('maps heading level 1 / 2 / 3 to the matching Word heading style', async () => {
    const { document: xml } = await inspect(
      docOf(
        heading(1, text('Chapter one')),
        heading(2, text('Section 1.1')),
        heading(3, text('Detail 1.1.1')),
        heading(9, text('out-of-range clamps to H1')),
      ),
      'headings',
    )
    expect(xml).toMatch(/w:val="Heading1"/)
    expect(xml).toMatch(/w:val="Heading2"/)
    expect(xml).toMatch(/w:val="Heading3"/)
    expect(xml).toContain('Chapter one')
    expect(xml).toContain('Section 1.1')
    expect(xml).toContain('Detail 1.1.1')
    // Out-of-range level falls back — text still appears.
    expect(xml).toContain('out-of-range clamps to H1')
  })

  it('applies bold / italic / strike mark flags to the underlying runs', async () => {
    const { document: xml } = await inspect(
      docOf(
        paragraph(
          text('plain '),
          text('bold', 'bold'),
          text(' '),
          text('italic', 'italic'),
          text(' '),
          text('struck', 'strike'),
        ),
      ),
      'marks',
    )
    expect(xml).toContain('bold')
    expect(xml).toContain('italic')
    expect(xml).toContain('struck')
    // Docx serialises the mark flags as w:b / w:i / w:strike elements
    // (with or without a w:val="true" attribute depending on version).
    expect(xml).toMatch(/<w:b(\s|\/)/)
    expect(xml).toMatch(/<w:i(\s|\/)/)
    expect(xml).toMatch(/<w:strike(\s|\/)/)
  })

  it('renders inline code with a monospace font on the run', async () => {
    const { document: xml } = await inspect(
      docOf(paragraph(text('call '), text('fetch(url)', 'code'))),
      'code',
    )
    expect(xml).toContain('fetch(url)')
    expect(xml).toContain('Courier New')
  })

  it('renders bulletList and orderedList as paragraphs with numbering props', async () => {
    const { document: xml, numbering } = await inspect(
      docOf(
        bulletList(
          listItem(paragraph(text('first bullet'))),
          listItem(paragraph(text('second bullet'))),
        ),
        orderedList(
          listItem(paragraph(text('step one'))),
          listItem(paragraph(text('step two'))),
        ),
      ),
      'lists',
    )
    expect(xml).toContain('first bullet')
    expect(xml).toContain('step one')
    // Every list paragraph carries a <w:numPr> block.
    expect(xml).toMatch(/<w:numPr>/)
    // numbering.xml is emitted for a doc that references numbering.
    expect(numbering).not.toBeNull()
    // Bullet marker '•' must appear somewhere in the numbering config.
    expect(numbering ?? '').toContain('•')
  })

  it('nested bulletList produces a level=1 numbering reference on inner paragraphs', async () => {
    const { document: xml } = await inspect(
      docOf(
        bulletList(
          listItem(
            paragraph(text('outer')),
            bulletList(listItem(paragraph(text('inner')))),
          ),
        ),
      ),
      'nested-list',
    )
    expect(xml).toContain('outer')
    expect(xml).toContain('inner')
    // Two paragraphs, one at level 0 and one at level 1.
    expect(xml).toMatch(/<w:ilvl w:val="0"\/>/)
    expect(xml).toMatch(/<w:ilvl w:val="1"\/>/)
  })

  it('renders a codeBlock as a shaded monospace paragraph', async () => {
    const { document: xml } = await inspect(
      docOf(codeBlock("if (x) { return 42 }")),
      'codeblock',
    )
    expect(xml).toContain('if (x) { return 42 }')
    expect(xml).toContain('Courier New')
    // Shaded background — the code block sets `shading.fill`.
    expect(xml).toContain('F5F5F5')
  })

  it('renders a horizontalRule as a paragraph with a bottom border', async () => {
    const { document: xml } = await inspect(
      docOf(paragraph(text('above')), hr(), paragraph(text('below'))),
      'hr',
    )
    expect(xml).toContain('above')
    expect(xml).toContain('below')
    // A paragraph border shows up as <w:pBdr>...<w:bottom .../>...
    expect(xml).toMatch(/<w:pBdr>[\s\S]*<w:bottom/)
  })

  it('emits a Break element for hardBreak', async () => {
    const { document: xml } = await inspect(
      docOf(paragraph(text('one'), hardBreak(), text('two'))),
      'br',
    )
    expect(xml).toContain('one')
    expect(xml).toContain('two')
    // The `break: 1` run option serialises as <w:br/>.
    expect(xml).toMatch(/<w:br\/>/)
  })

  it('DROPS comment marks — highlight is annotation, not content', async () => {
    const { document: xml } = await inspect(
      docOf(
        paragraph(
          text('plain, '),
          text('flagged for review', 'comment'),
          text(', continuing'),
        ),
      ),
      'comments',
    )
    // Underlying text is preserved …
    expect(xml).toContain('flagged for review')
    // … but nothing comment-related leaks into the XML.
    expect(xml).not.toContain('data-comment-id')
    expect(xml).not.toContain('comment-highlight')
    expect(xml).not.toContain('markId')
  })

  it('blockquote left-indents its paragraphs (720 twip per depth)', async () => {
    const { document: xml } = await inspect(
      docOf(blockquote(paragraph(text('quoted line')))),
      'quote',
    )
    expect(xml).toContain('quoted line')
    // 720 twip = 0.5 inch — the default per-level indent.
    expect(xml).toMatch(/<w:ind w:left="720"/)
  })

  it('produces valid bytes for an empty document', async () => {
    const bytes = await buildDocxBytes(docOf(), 'empty')
    expect(bytes.length).toBeGreaterThan(500)
    const { document: xml } = await inspectDocxBytes(bytes)
    // Even an empty document has at least one paragraph so Word does
    // not choke.
    expect(xml).toMatch(/<w:p[\s>/]/)
  })
})

describe('slugifyForDocxFilename', () => {
  it('normalises whitespace and punctuation to single hyphens', () => {
    expect(slugifyForDocxFilename('Thermal Vacuum Test Report v3')).toBe(
      'thermal-vacuum-test-report-v3',
    )
  })
  it('trims leading and trailing hyphens', () => {
    expect(slugifyForDocxFilename('  ---Hello, World!!! ---  ')).toBe(
      'hello-world',
    )
  })
  it('caps at 120 characters', () => {
    const long = 'a'.repeat(200)
    expect(slugifyForDocxFilename(long).length).toBe(120)
  })
  it('falls back to "document" when the title normalises to empty', () => {
    expect(slugifyForDocxFilename('!!!')).toBe('document')
    expect(slugifyForDocxFilename('')).toBe('document')
  })
})
