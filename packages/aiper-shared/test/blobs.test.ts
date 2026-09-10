import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UploadResponseSchema } from '../src/schemas/index.js'
import { UPLOAD_MAX_BYTES } from '../src/types/index.js'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SHA256_HEX = 'a'.repeat(64)

test('UploadResponseSchema parses a well-formed DOCX upload response', () => {
  const parsed = UploadResponseSchema.parse({
    blobId: UUID_A,
    filename: 'MISSION-X-Payload-TVAC-Report-Rev2.docx',
    mime: DOCX_MIME,
    sizeBytes: 1_234_567,
    sha256: SHA256_HEX,
  })
  assert.equal(parsed.mime, DOCX_MIME)
  assert.equal(parsed.sizeBytes, 1_234_567)
})

test('UploadResponseSchema rejects wrong mime, oversize, and non-hex sha256', () => {
  // MIME not on the allowlist (PDF)
  assert.throws(() =>
    UploadResponseSchema.parse({
      blobId: UUID_A,
      filename: 'x.pdf',
      mime: 'application/pdf',
      sizeBytes: 1000,
      sha256: SHA256_HEX,
    }),
  )
  // One byte over the 20 MB cap
  assert.throws(() =>
    UploadResponseSchema.parse({
      blobId: UUID_A,
      filename: 'x.docx',
      mime: DOCX_MIME,
      sizeBytes: UPLOAD_MAX_BYTES + 1,
      sha256: SHA256_HEX,
    }),
  )
  // Uppercase hex — sha256 must be lowercase
  assert.throws(() =>
    UploadResponseSchema.parse({
      blobId: UUID_A,
      filename: 'x.docx',
      mime: DOCX_MIME,
      sizeBytes: 1000,
      sha256: 'A'.repeat(64),
    }),
  )
})
