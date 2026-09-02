import mammoth from 'mammoth'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { AiperDocumentModel, PMNode } from './model'
import { DEFAULT_PAGE_SETUP } from './model'
import { htmlToPmDoc } from './html-to-pm'

const STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='CTD Section'] => p.ctd-section:fresh",
  "p[style-name='Reference'] => p.reference:fresh",
  "p[style-name='Table Caption'] => p.table-caption:fresh"
]

export interface ImportResult {
  model: AiperDocumentModel
  warnings: string[]
}

/**
 * mammoth silently resolves (accepts) any tracked changes already in the source file and
 * drops headers/footers entirely — both are real Word features a regulatory reviewer may
 * rely on. Scan the raw OOXML first so callers can warn the user before that happens,
 * rather than silently discarding a reviewer's revision history.
 */
async function scanForUnsupportedRevisions(buffer: Buffer): Promise<string[]> {
  const warnings: string[] = []
  try {
    const zip = await JSZip.loadAsync(buffer)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    if (documentXml) {
      const insCount = (documentXml.match(/<w:ins /g) ?? []).length
      const delCount = (documentXml.match(/<w:del /g) ?? []).length
      const commentCount = (documentXml.match(/<w:commentReference/g) ?? []).length
      if (insCount + delCount > 0) {
        warnings.push(
          `This document contains ${insCount + delCount} pre-existing tracked change(s) that Aiper cannot preserve on import — they will be accepted into plain text.`
        )
      }
      if (commentCount > 0) {
        warnings.push(
          `This document contains ${commentCount} existing comment(s) that Aiper cannot import — open a copy in Word first if you need to preserve them.`
        )
      }
    }
  } catch {
    // Not a valid zip / docx — importDocx below will raise the real error.
  }
  return warnings
}

async function readSectionProperties(buffer: Buffer): ReturnType<typeof readSectionPropertiesImpl> {
  return readSectionPropertiesImpl(buffer)
}

async function readSectionPropertiesImpl(buffer: Buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    if (!documentXml) return DEFAULT_PAGE_SETUP
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
    const parsed = parser.parse(documentXml)
    const sectPr = parsed?.['w:document']?.['w:body']?.['w:sectPr']
    const pgSz = sectPr?.['w:pgSz']
    const pgMar = sectPr?.['w:pgMar']
    if (!pgSz && !pgMar) return DEFAULT_PAGE_SETUP
    const twipsToMm = (twips: number): number => (twips / 1440) * 25.4
    const widthTwips = Number(pgSz?.['@_w:w'] ?? 11906)
    const heightTwips = Number(pgSz?.['@_w:h'] ?? 16838)
    return {
      size: widthTwips > 12000 ? ('Letter' as const) : ('A4' as const),
      orientation: widthTwips > heightTwips ? ('landscape' as const) : ('portrait' as const),
      marginTopMm: pgMar ? twipsToMm(Number(pgMar['@_w:top'] ?? 1440)) : DEFAULT_PAGE_SETUP.marginTopMm,
      marginBottomMm: pgMar ? twipsToMm(Number(pgMar['@_w:bottom'] ?? 1440)) : DEFAULT_PAGE_SETUP.marginBottomMm,
      marginLeftMm: pgMar ? twipsToMm(Number(pgMar['@_w:left'] ?? 1440)) : DEFAULT_PAGE_SETUP.marginLeftMm,
      marginRightMm: pgMar ? twipsToMm(Number(pgMar['@_w:right'] ?? 1440)) : DEFAULT_PAGE_SETUP.marginRightMm,
      columns: 1
    }
  } catch {
    return DEFAULT_PAGE_SETUP
  }
}

export async function importDocx(buffer: Buffer, title = 'Untitled'): Promise<ImportResult> {
  const warnings = await scanForUnsupportedRevisions(buffer)
  const { value: html, messages } = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP })
  for (const m of messages) {
    if (m.type === 'warning') warnings.push(m.message)
  }
  const pageSetup = await readSectionProperties(buffer)
  const content: PMNode = htmlToPmDoc(html)

  return {
    model: { title, content, pageSetup, header: null, footer: null },
    warnings
  }
}
