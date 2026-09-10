import { JSDOM } from 'jsdom'
import type { PMNode } from './model'

const MARK_TAGS: Record<string, { type: string; attrs?: Record<string, unknown> }> = {
  STRONG: { type: 'bold' },
  B: { type: 'bold' },
  EM: { type: 'italic' },
  I: { type: 'italic' },
  U: { type: 'underline' },
  S: { type: 'strike' },
  STRIKE: { type: 'strike' },
  SUB: { type: 'subscript' },
  SUP: { type: 'superscript' }
}

const HEADING_TAGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }

function walkInline(node: Node, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): PMNode[] {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.textContent ?? ''
    if (!text) return []
    return [{ type: 'text', text, marks: marks.length ? marks : undefined }]
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return []
  const el = node as Element
  if (el.tagName === 'BR') return [{ type: 'hardBreak' }]

  if (el.tagName === 'A') {
    const href = el.getAttribute('href') ?? ''
    const nextMarks = [...marks, { type: 'link', attrs: { href } }]
    return Array.from(el.childNodes).flatMap((c) => walkInline(c, nextMarks))
  }

  const markDef = MARK_TAGS[el.tagName]
  const nextMarks = markDef ? [...marks, markDef] : marks
  return Array.from(el.childNodes).flatMap((c) => walkInline(c, nextMarks))
}

function paragraphStyleFromClass(el: Element): Record<string, unknown> | undefined {
  if (el.classList.contains('ctd-section')) return { styleName: 'ctdSection' }
  if (el.classList.contains('reference')) return { styleName: 'reference' }
  if (el.classList.contains('table-caption')) return { styleName: 'tableCaption' }
  return undefined
}

function walkBlock(el: Element): PMNode | PMNode[] | null {
  switch (el.tagName) {
    case 'P': {
      const attrs = paragraphStyleFromClass(el)
      const inline = Array.from(el.childNodes).flatMap((c) => walkInline(c, []))
      return { type: 'paragraph', attrs, content: inline.length ? inline : undefined }
    }
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const inline = Array.from(el.childNodes).flatMap((c) => walkInline(c, []))
      return { type: 'heading', attrs: { level: HEADING_TAGS[el.tagName] }, content: inline.length ? inline : undefined }
    }
    case 'UL':
    case 'OL': {
      const items = Array.from(el.children)
        .filter((c) => c.tagName === 'LI')
        .map((li) => walkListItem(li))
      return { type: el.tagName === 'UL' ? 'bulletList' : 'orderedList', content: items }
    }
    case 'TABLE': {
      const rows = Array.from(el.querySelectorAll(':scope > tbody > tr, :scope > tr')).map((tr) => walkTableRow(tr))
      return { type: 'table', content: rows }
    }
    case 'IMG': {
      return {
        type: 'image',
        attrs: { src: el.getAttribute('src'), alt: el.getAttribute('alt') ?? '' }
      }
    }
    case 'BLOCKQUOTE': {
      const inner = Array.from(el.children)
        .map((c) => walkBlock(c))
        .flat()
        .filter((n): n is PMNode => Boolean(n))
      return { type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] }
    }
    default:
      return null
  }
}

function walkListItem(li: Element): PMNode {
  const blocks = Array.from(li.children)
    .map((c) => walkBlock(c))
    .flat()
    .filter((n): n is PMNode => Boolean(n))
  const inline = blocks.length ? [] : Array.from(li.childNodes).flatMap((c) => walkInline(c, []))
  return {
    type: 'listItem',
    content: blocks.length ? blocks : [{ type: 'paragraph', content: inline.length ? inline : undefined }]
  }
}

function walkTableRow(tr: Element): PMNode {
  const cells = Array.from(tr.children)
    .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    .map((cell) => ({
      type: cell.tagName === 'TH' ? 'tableHeader' : 'tableCell',
      content: [
        { type: 'paragraph', content: Array.from(cell.childNodes).flatMap((c) => walkInline(c, [])) || undefined }
      ]
    }))
  return { type: 'tableRow', content: cells }
}

export function htmlToPmDoc(html: string): PMNode {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  const body = dom.window.document.body
  const content = Array.from(body.children)
    .map((el) => walkBlock(el))
    .flat()
    .filter((n): n is PMNode => Boolean(n))

  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}
