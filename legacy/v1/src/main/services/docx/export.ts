import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  InsertedTextRun,
  DeletedTextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  ExternalHyperlink,
  AlignmentType,
  WidthType,
  convertMillimetersToTwip,
  PageOrientation,
  PageBreak,
  Header,
  Footer
} from 'docx'
import type { IPropertiesOptions } from 'docx'
import type { AiperDocumentModel, PMNode } from './model'
import { DEFAULT_PAGE_SETUP } from './model'

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
]

type DocxRun = TextRun | InsertedTextRun | DeletedTextRun | ExternalHyperlink

/** OOXML wants bare 6-digit hex; the editor stores CSS colours (`#rrggbb`, `#rgb`, or a
 *  named colour). Returns undefined for anything not expressible as hex so the run simply
 *  inherits, rather than emitting an attribute Word would reject. */
function toDocxHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const hex = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase()
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return hex
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()
  }
  return undefined
}

function runsFromInline(nodes: PMNode[] | undefined): DocxRun[] {
  if (!nodes) return []
  const out: DocxRun[] = []
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }))
      continue
    }
    if (node.type !== 'text' || !node.text) continue
    const marks = node.marks ?? []
    const bold = marks.some((m) => m.type === 'bold')
    const italics = marks.some((m) => m.type === 'italic')
    const underline = marks.some((m) => m.type === 'underline') ? {} : undefined
    const strike = marks.some((m) => m.type === 'strike')
    const subScript = marks.some((m) => m.type === 'subscript')
    const superScript = marks.some((m) => m.type === 'superscript')
    const link = marks.find((m) => m.type === 'link')
    const insertion = marks.find((m) => m.type === 'insertion')
    const deletion = marks.find((m) => m.type === 'deletion')

    // textStyle carries fontFamily/fontSize (see renderer editor/extensions/fontAttributes.ts);
    // colour and highlight are their own marks. All four were previously dropped on export.
    const textStyle = marks.find((m) => m.type === 'textStyle')
    const colorMark = marks.find((m) => m.type === 'textStyle' && m.attrs?.color) ?? marks.find((m) => m.type === 'color')
    const highlightMark = marks.find((m) => m.type === 'highlight')

    const fontFamily = textStyle?.attrs?.fontFamily ? String(textStyle.attrs.fontFamily) : undefined
    // docx sizes runs in half-points; the editor stores whole points.
    const fontSizePt = Number(textStyle?.attrs?.fontSize)
    const size = Number.isFinite(fontSizePt) && fontSizePt > 0 ? Math.round(fontSizePt * 2) : undefined
    const color = toDocxHex(colorMark?.attrs?.color)
    const highlightHex = toDocxHex(highlightMark?.attrs?.color)

    const opts = {
      text: node.text,
      bold,
      italics,
      underline,
      strike,
      subScript,
      superScript,
      ...(fontFamily ? { font: fontFamily } : {}),
      ...(size ? { size } : {}),
      ...(color ? { color } : {}),
      ...(highlightHex ? { shading: { fill: highlightHex } } : {})
    }

    let run: DocxRun
    if (deletion) {
      run = new DeletedTextRun({
        ...opts,
        text: undefined as never,
        children: [node.text],
        author: String(deletion.attrs?.authorName ?? 'Reviewer'),
        date: String(deletion.attrs?.timestamp ?? new Date().toISOString())
      } as never)
    } else if (insertion) {
      run = new InsertedTextRun({
        ...opts,
        text: undefined as never,
        children: [node.text],
        author: String(insertion.attrs?.authorName ?? 'Reviewer'),
        date: String(insertion.attrs?.timestamp ?? new Date().toISOString())
      } as never)
    } else {
      run = new TextRun(opts)
    }

    if (link) {
      out.push(
        new ExternalHyperlink({
          link: String(link.attrs?.href ?? '#'),
          children: [run as TextRun]
        })
      )
    } else {
      out.push(run)
    }
  }
  return out
}

const ALIGN_MAP: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

/** Named paragraph styles from the Styles gallery. `style` references a style id that must
 *  also be declared in the Document's `styles.paragraphStyles` (see exportDocx) or Word
 *  silently ignores it. These are the domain-specific CTD styles, so losing them on export
 *  is a real content loss, not a cosmetic one. */
const PARAGRAPH_STYLE_IDS: Record<string, string> = {
  ctdSection: 'CTDSection',
  reference: 'Reference',
  tableCaption: 'TableCaption'
}

/** Shared paragraph-level formatting: alignment, indent level, and line spacing — all of
 *  which the editor stores as node attrs (see renderer editor/extensions/indent.ts). */
function paragraphFormatting(node: PMNode): {
  alignment?: (typeof AlignmentType)[keyof typeof AlignmentType]
  indent?: { left: number }
  spacing?: { line: number }
  style?: string
} {
  const align = node.attrs?.textAlign as string | undefined
  const indentLevel = Number(node.attrs?.indent) || 0
  const lineSpacing = Number(node.attrs?.lineSpacing) || 1
  const styleName = node.attrs?.styleName as string | undefined

  return {
    alignment: align ? ALIGN_MAP[align] : undefined,
    // The editor renders one indent step as 24px; Word measures in twips (1440 per inch).
    indent: indentLevel > 0 ? { left: indentLevel * convertMillimetersToTwip(6.35) } : undefined,
    // docx expresses line spacing in 240ths of a line (240 = single).
    spacing: lineSpacing !== 1 ? { line: Math.round(lineSpacing * 240) } : undefined,
    style: styleName ? PARAGRAPH_STYLE_IDS[styleName] : undefined
  }
}

function blockToDocx(node: PMNode): Array<Paragraph | Table> {
  switch (node.type) {
    case 'paragraph': {
      return [
        new Paragraph({
          ...paragraphFormatting(node),
          children: runsFromInline(node.content)
        })
      ]
    }
    case 'pageBreak': {
      return [new Paragraph({ children: [new PageBreak()] })]
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6)
      return [
        new Paragraph({
          ...paragraphFormatting(node),
          heading: HEADING_LEVELS[level - 1],
          children: runsFromInline(node.content)
        })
      ]
    }
    case 'bulletList':
      return (node.content ?? []).flatMap((li) => listItemToDocx(li, 'bullet'))
    case 'orderedList':
      return (node.content ?? []).flatMap((li) => listItemToDocx(li, 'number'))
    case 'blockquote':
      return (node.content ?? []).flatMap((child) => blockToDocx(child)).filter((n): n is Paragraph => n instanceof Paragraph)
    case 'table': {
      const rows = (node.content ?? []).map(
        (row) =>
          new TableRow({
            children: (row.content ?? []).map(
              (cell) =>
                new TableCell({
                  width: { size: 100 / (row.content?.length || 1), type: WidthType.PERCENTAGE },
                  children: (cell.content ?? []).flatMap((c) => blockToDocx(c)).filter((n): n is Paragraph => n instanceof Paragraph)
                })
            )
          })
      )
      return [new Table({ rows })]
    }
    case 'image': {
      return [
        new Paragraph({
          children: node.attrs?.src
            ? [
                new ImageRun({
                  type: 'png',
                  data: Buffer.from(String(node.attrs.src).split(',')[1] ?? '', 'base64'),
                  transformation: { width: 400, height: 300 }
                })
              ]
            : []
        })
      ]
    }
    default:
      return []
  }
}

function listItemToDocx(li: PMNode, kind: 'bullet' | 'number'): Paragraph[] {
  return (li.content ?? []).flatMap((child) => {
    if (child.type !== 'paragraph') return blockToDocx(child).filter((n): n is Paragraph => n instanceof Paragraph)
    return [
      new Paragraph({
        bullet: kind === 'bullet' ? { level: 0 } : undefined,
        numbering: kind === 'number' ? { reference: 'aiper-numbering', level: 0 } : undefined,
        children: runsFromInline(child.content)
      })
    ]
  })
}

export async function exportDocx(model: AiperDocumentModel): Promise<Buffer> {
  const children = (model.content.content ?? []).flatMap((node) => blockToDocx(node))

  // A document that has never been saved from the editor carries no page setup — that is every
  // new, imported and uploaded document. Defaulting here rather than refusing keeps the
  // compliance check working on a freshly imported submission, which is the whole point of it.
  const pageSetup = model.pageSetup ?? DEFAULT_PAGE_SETUP

  const sectionProperties: IPropertiesOptions['sections'][number]['properties'] = {
    page: {
      size: {
        width: convertMillimetersToTwip(pageSetup.size === 'A4' ? 210 : 215.9),
        height: convertMillimetersToTwip(pageSetup.size === 'A4' ? 297 : 279.4),
        orientation: pageSetup.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
      },
      margin: {
        top: convertMillimetersToTwip(pageSetup.marginTopMm),
        bottom: convertMillimetersToTwip(pageSetup.marginBottomMm),
        left: convertMillimetersToTwip(pageSetup.marginLeftMm),
        right: convertMillimetersToTwip(pageSetup.marginRightMm)
      }
    }
  }

  const headerParagraphs = model.header
    ? (model.header.content ?? []).flatMap((n) => blockToDocx(n)).filter((n): n is Paragraph => n instanceof Paragraph)
    : []
  const footerParagraphs = model.footer
    ? (model.footer.content ?? []).flatMap((n) => blockToDocx(n)).filter((n): n is Paragraph => n instanceof Paragraph)
    : []

  const doc = new Document({
    title: model.title,
    // Word ignores a paragraph `style` reference unless the style id is declared here.
    styles: {
      paragraphStyles: [
        {
          id: 'CTDSection',
          name: 'CTD Section',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { bold: true, allCaps: true, size: 22 },
          paragraph: { spacing: { before: 240, after: 120 } }
        },
        {
          id: 'Reference',
          name: 'Reference',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 20 },
          paragraph: { indent: { left: 360, hanging: 360 } }
        },
        {
          id: 'TableCaption',
          name: 'Table Caption',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { italics: true, size: 20 }
        }
      ]
    },
    numbering: {
      config: [
        {
          reference: 'aiper-numbering',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }]
        }
      ]
    },
    sections: [
      {
        properties: sectionProperties,
        headers: headerParagraphs.length ? { default: new Header({ children: headerParagraphs }) } : undefined,
        footers: footerParagraphs.length ? { default: new Footer({ children: footerParagraphs }) } : undefined,
        children
      }
    ]
  })

  return Packer.toBuffer(doc)
}
