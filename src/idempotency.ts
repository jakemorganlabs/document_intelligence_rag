// Idempotency check: skip re-ingest of unchanged content (FR-IG-5).
// Returns `skip` when a document with the same hash already exists.
import type { PoolClient } from "pg";
import { findDocumentByHash } from "./db.js";

export interface IdempotencyResult {
  action: "skip" | "proceed";
  documentId?: string;
  reason?: string;
}

export async function checkIdempotency(
  contentHash: string,
  client: PoolClient
): Promise<IdempotencyResult> {
  const existing = await findDocumentByHash(contentHash, client);
  if (existing) {
    return {
      action: "skip",
      documentId: existing.document_id,
      reason: "Document with identical content_hash already exists",
    };
  }
  return { action: "proceed" };
}
