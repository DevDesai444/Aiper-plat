/**
 * Week-5 interface freeze for the blob layer: response shape of the upload
 * endpoint plus the cap and MIME allowlist every uploader validates against.
 * Frozen ahead of the endpoint itself so E4's product-tree upload flow can
 * type its client against the final shape without waiting for the route.
 */

/**
 * Response shape of POST /api/v1/blobs. `sha256` is the server-computed
 * digest of the stored bytes in lowercase hex — clients round-trip it to
 * verify the download matches what was uploaded.
 */
export interface UploadResponse {
  blobId: string
  filename: string
  mime: string
  sizeBytes: number
  sha256: string   // hex
}

/**
 * Upload size cap enforced at every entry point (Fastify body limit, any
 * presigned URL policy, and the client-side pre-flight). 20 MB — a DOCX
 * with embedded images for an ECSS report fits comfortably under this.
 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024  // 20 MB

/**
 * MIME allowlist. Kept as a `const` tuple so `UploadAllowedMime` derives
 * from it — a new entry added here flows through the runtime schema and
 * every exhaustive check in one edit.
 */
export const UPLOAD_ALLOWED_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
] as const

export type UploadAllowedMime = (typeof UPLOAD_ALLOWED_MIMES)[number]
