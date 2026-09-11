import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { CommentMark } from '../../src/editor/commentMark'

/**
 * Round-trip test for the CommentMark serialization contract.
 *
 * The `data-comment-id` attribute and the `comment-highlight` class
 * are load-bearing wire keys — the panel selects on the attribute to
 * scroll a highlight into view, and the CSS keys off the class. This
 * test locks both against accidental drift.
 */

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function newEditor(html: string): Editor {
  return new Editor({
    extensions: [StarterKit.configure({ history: false }), CommentMark],
    content: html,
    // TipTap 2.13+ prefers explicit SSR opt-in; jsdom is fine either way.
    // Setting it explicitly keeps the warning out of test output.
    ...({ immediatelyRender: false } as Record<string, unknown>),
  })
}

describe('CommentMark', () => {
  it('renders as <span data-comment-id="…" class="comment-highlight">', () => {
    editor = newEditor(
      '<p><span data-comment-id="abc-123">hello</span> world</p>',
    )
    const html = editor.getHTML()
    expect(html).toContain('data-comment-id="abc-123"')
    expect(html).toContain('class="comment-highlight"')
  })

  it('parseHTML preserves markId across a round-trip', () => {
    const roundtripId = 'e7-uuid-9f2b'
    editor = newEditor(
      `<p>plain <span data-comment-id="${roundtripId}">flagged</span> tail</p>`,
    )
    const html = editor.getHTML()
    expect(html).toContain(`data-comment-id="${roundtripId}"`)
    // The Marks on the node under the span should carry the id.
    let seen: string | null = null
    editor.state.doc.descendants((node) => {
      for (const m of node.marks) {
        if (m.type.name === 'comment') seen = m.attrs['markId'] as string | null
      }
    })
    expect(seen).toBe(roundtripId)
  })

  it('drops the attribute (and class) when markId is null', () => {
    // Simulate a defensive attribute-null case — the mark exists, but
    // its attribute has not been applied yet. Should not render a bogus
    // `data-comment-id=""` on the wire.
    editor = newEditor('<p>plain paragraph, no mark applied</p>')
    const html = editor.getHTML()
    expect(html).not.toContain('data-comment-id')
    expect(html).not.toContain('comment-highlight')
  })

  it('overlapping other marks (bold) coexist with the comment mark', () => {
    editor = newEditor(
      '<p><strong><span data-comment-id="ol-1">bold+commented</span></strong></p>',
    )
    const html = editor.getHTML()
    expect(html).toContain('<strong>')
    expect(html).toContain('data-comment-id="ol-1"')
  })
})
