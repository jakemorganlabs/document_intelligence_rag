// Vector store writer: transactional upsert of documents + chunks.
//
// Wraps the document row and all chunk rows in a single transaction. On
// failure, rolls back. Nothing partial remains.
import type { PoolClient } from "pg";
import type { ChunkRecord } from "../types/index.js";
import { insertDocument, updateDocumentStatus, insertChunks, deleteChunksByDocument } from "./db.js";
import { insertDeadLetter } from "./db.js";
import { sendSlackAlert } from "./alerts.js";

export interface IngestRecord {
  source: string;
  contentHash: string;
  pageCount: number;
  chunks: ChunkRecord[];
}

export interface PersistResult {
  documentId: string;
  chunksInserted: number;
}

// Insert a document and all its chunks in one transaction.
export async function persistIngest(
  record: IngestRecord,
  client: PoolClient
): Promise<PersistResult> {
  await client.query("BEGIN");

  try {
    const documentId = await insertDocument(
      {
        source: record.source,
        content_hash: record.contentHash,
        page_count: record.pageCount,
        chunk_count: 0,
        status: "indexing",
      },
      client
    );

    const chunksWithDoc = record.chunks.map((c) => ({
      ...c,
      document_id: documentId,
    }));

    await insertChunks(chunksWithDoc, client);

    await updateDocumentStatus(documentId, "indexed", chunksWithDoc.length, client);

    await client.query("COMMIT");

    return { documentId, chunksInserted: chunksWithDoc.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// Replace an existing document: delete old chunks, insert new ones, update
// status. All in one transaction.
export async function replaceDocument(
  existingDocumentId: string,
  record: IngestRecord,
  client: PoolClient
): Promise<PersistResult> {
  await client.query("BEGIN");

  try {
    await deleteChunksByDocument(existingDocumentId, client);

    const chunksWithDoc = record.chunks.map((c) => ({
      ...c,
      document_id: existingDocumentId,
    }));

    await insertChunks(chunksWithDoc, client);

    await client.query(
      `UPDATE documents
       SET page_count = $1, chunk_count = $2, status = 'indexed', updated_at = NOW()
       WHERE document_id = $3`,
      [record.pageCount, chunksWithDoc.length, existingDocumentId]
    );

    await client.query("COMMIT");

    return { documentId: existingDocumentId, chunksInserted: chunksWithDoc.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// Route a persistent failure into the dead-letter queue. Also fires a Slack
// alert. Best-effort; does not block on alert failure.
export async function routeToDeadLetter(
  client: PoolClient,
  opts: {
    stage: string;
    itemType: string;
    itemSnapshot: unknown;
    error: string;
    errorCode: string;
  }
): Promise<void> {
  await insertDeadLetter(client, opts);
  // best-effort alert, fire-and-forget
  sendSlackAlert({
    stage: opts.stage,
    error: opts.error,
    itemType: opts.itemType,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Slack alert failed:", err instanceof Error ? err.message : String(err));
  });
}
