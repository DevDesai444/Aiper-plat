/**
 * Runtime validator mirroring the interface in ../types/blobs.ts. Consumers
 * use it at trust boundaries — the upload response deserialiser, any client
 * that persists the record, tests. Pairs 1:1 with UploadResponse; edit both
 * files in the same PR.
 *
 * The MIME allowlist and the size cap come from the types module rather than
 * being re-listed here so a new entry lands in one place and both the type
 * and the schema pick it up.
 */

import { z } from 'zod'
import { UPLOAD_ALLOWED_MIMES, UPLOAD_MAX_BYTES } from '../types/blobs.js'

export const UploadResponseSchema = z.object({
  blobId: z.string().uuid(),
  filename: z.string().min(1).max(500),
  mime: z.enum(UPLOAD_ALLOWED_MIMES),
  sizeBytes: z.number().int().nonnegative().max(UPLOAD_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
