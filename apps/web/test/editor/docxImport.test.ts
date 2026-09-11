import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  __setMammothLoader,
  convertDocxToHtml,
} from '../../src/editor/docxImport'

/**
 * Unit tests for the mammoth wrapper. We inject a fake mammoth via
 * `__setMammothLoader` rather than depending on the real 1 MB lib —
 * the wrapper contract (call surface, message normalisation, source
 * coercion) is what we care about here; the real-mammoth path is
 * exercised in the integration test where a real .docx is imported.
 */

afterEach(() => __setMammothLoader(null))

describe('convertDocxToHtml', () => {
  it('returns mammoth html + filters empty / undefined messages', async () => {
    const convertToHtml = vi.fn(async (_input: { arrayBuffer: ArrayBuffer }) => ({
      value: '<h1>Hello</h1><p>World</p>',
      messages: [
        { type: 'warning', message: 'Unrecognized paragraph style' },
        { type: 'error', message: '   ' }, // whitespace-only — filtered
        { type: 'info' as const }, // no message field — filtered
      ],
    }))
    __setMammothLoader(async () => ({ convertToHtml }))

    const result = await convertDocxToHtml(new ArrayBuffer(8))

    expect(convertToHtml).toHaveBeenCalledTimes(1)
    expect(result.html).toBe('<h1>Hello</h1><p>World</p>')
    expect(result.warnings).toEqual(['Unrecognized paragraph style'])
  })

  it('is defensive about a malformed mammoth result (missing value + messages)', async () => {
    __setMammothLoader(async () => ({
      convertToHtml: async () => ({}),
    }))
    const result = await convertDocxToHtml(new ArrayBuffer(0))
    expect(result.html).toBe('')
    expect(result.warnings).toEqual([])
  })

  it('reads File.arrayBuffer() when handed a File instead of a raw buffer', async () => {
    const convertToHtml = vi.fn(async (_input: { arrayBuffer: ArrayBuffer }) => ({
      value: '<p>x</p>',
      messages: [],
    }))
    __setMammothLoader(async () => ({ convertToHtml }))

    const file = new File(['fake docx bytes'], 'test.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    await convertDocxToHtml(file)

    expect(convertToHtml).toHaveBeenCalledTimes(1)
    const arg = convertToHtml.mock.calls[0]![0]
    expect(arg.arrayBuffer).toBeInstanceOf(ArrayBuffer)
    // File contents survive the coercion — 'fake docx bytes' is 15 bytes.
    expect(arg.arrayBuffer.byteLength).toBe(15)
  })
})
