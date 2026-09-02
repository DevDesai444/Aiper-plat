import { exportDocx } from '../src/main/services/docx/export'
import type { AiperDocumentModel } from '../src/main/services/docx/model'
import JSZip from 'jszip'

/**
 * Guards the formatting that export.ts previously dropped silently: fonts, sizes, colour,
 * highlight, indent, line spacing, the CTD paragraph styles, and page breaks. Asserts against
 * the generated OOXML rather than a re-import, because mammoth (used on import) discards most
 * of this on the way back in — so a round-trip check would pass while the file was still wrong.
 */
async function main(): Promise<void> {
  const model: AiperDocumentModel = {
    title: 'Fidelity Test',
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { styleName: 'ctdSection' },
          content: [{ type: 'text', text: '3.2.P.5 CONTROL OF DRUG PRODUCT' }]
        },
        {
          type: 'paragraph',
          attrs: { indent: 2, lineSpacing: 1.5, textAlign: 'justify' },
          content: [
            {
              type: 'text',
              text: 'Assay limit',
              marks: [
                { type: 'textStyle', attrs: { fontFamily: 'Courier New', fontSize: 14 } },
                { type: 'highlight', attrs: { color: '#ffff00' } }
              ]
            },
            { type: 'text', text: ' 90.0-110.0%', marks: [{ type: 'textStyle', attrs: { color: '#c00000' } }] }
          ]
        },
        { type: 'pageBreak' },
        { type: 'paragraph', attrs: { styleName: 'reference' }, content: [{ type: 'text', text: 'ICH Q6A' }] },
        { type: 'paragraph', attrs: { styleName: 'tableCaption' }, content: [{ type: 'text', text: 'Table 1' }] }
      ]
    },
    pageSetup: {
      size: 'A4',
      orientation: 'portrait',
      marginTopMm: 25.4,
      marginBottomMm: 25.4,
      marginLeftMm: 25.4,
      marginRightMm: 25.4,
      columns: 1
    },
    header: null,
    footer: null
  }

  const buffer = await exportDocx(model)
  const zip = await JSZip.loadAsync(buffer)
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
  const styles = (await zip.file('word/styles.xml')?.async('string')) ?? ''

  const checks: Array<[string, boolean]> = [
    ['font family preserved', xml.includes('Courier New')],
    ['font size preserved (14pt -> 28 half-points)', /w:sz w:val="28"/.test(xml)],
    ['text colour preserved', xml.includes('C00000')],
    ['highlight preserved', xml.includes('FFFF00')],
    ['indent preserved', /w:ind[^>]*w:left="\d+"/.test(xml)],
    ['line spacing preserved', /w:spacing[^>]*w:line="360"/.test(xml)],
    ['justify alignment preserved', xml.includes('w:val="both"') || xml.includes('w:val="justify"')],
    ['page break emitted', xml.includes('w:br') && xml.includes('type="page"')],
    ['CTDSection style referenced', xml.includes('CTDSection')],
    ['Reference style referenced', xml.includes('Reference')],
    ['TableCaption style referenced', xml.includes('TableCaption')],
    ['CTDSection style declared in styles.xml', styles.includes('CTDSection')],
    ['Reference style declared in styles.xml', styles.includes('Reference')],
    ['TableCaption style declared in styles.xml', styles.includes('TableCaption')]
  ]

  let allPass = true
  for (const [name, pass] of checks) {
    console.log(pass ? 'PASS' : 'FAIL', name)
    if (!pass) allPass = false
  }
  console.log(allPass ? '\nALL PASS' : '\nSOME FAILED')
  process.exit(allPass ? 0 : 1)
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
