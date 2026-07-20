// Database repository: CRUD for documents and chunks.
//
// All operations use parameterised queries to prevent injection (FR-PS-1,
// FR-IG-5).
import { Client, type Pool, type PoolClient } from "pg";
import type { ChunkRecord } from "../types/index.js";

export interface DocumentRow {
  document_id: string;
  source: string;
  content_hash: string;
  page_count: number;
  chunk_count: number;
  status: string;
  ingested_at: Date;
  updated_at: Date;
}

export interface ChunkRow extends ChunkRecord {}

let poolInstance: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (poolInstance) return poolInstance;

  const { Pool } = await import("pg");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL not set");
  }
  poolInstance = new Pool({ connectionString });
  return poolInstance;
}

export async function getClient(): Promise<PoolClient> {
  const pool = await getPool();
  return pool.connect();
}

// document queries

export async function findDocumentByHash(
  hash: string,
  client: PoolClient | Client
): Promise<DocumentRow | null> {
  const res = await client.query<DocumentRow>(
    `SELECT * FROM documents WHERE content_hash = $1`,
    [hash]
  );
  return res.rows[0] ?? null;
}

// Upsert a document: INSERT or UPDATE on content_hash conflict. Returns the
// document_id regardless of insert vs update.
export async function upsertDocument(
  row: Omit<DocumentRow, "document_id" | "ingested_at" | "updated_at">,
  client: PoolClient | Client
): Promise<string> {
  const res = await client.query<{ document_id: string }>(
    `INSERT INTO documents (source, content_hash, page_count, chunk_count, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (content_hash) DO UPDATE
     SET page_count = EXCLUDED.page_count,
         chunk_count = EXCLUDED.chunk_count,
         status = EXCLUDED.status,
         updated_at = NOW()
     RETURNING document_id`,
    [row.source, row.content_hash, row.page_count, row.chunk_count, row.status]
  );
  return res.rows[0]!.document_id;
}

export async function insertDocument(
  row: Omit<DocumentRow, "document_id" | "ingested_at" | "updated_at">,
  client: PoolClient | Client
): Promise<string> {
  const res = await client.query<{ document_id: string }>(
    `INSERT INTO documents (source, content_hash, page_count, chunk_count, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING document_id`,
    [row.source, row.content_hash, row.page_count, row.chunk_count, row.status]
  );
  if (res.rows.length === 0) {
    throw new Error("Unique constraint violation on content_hash");
  }
  return res.rows[0]!.document_id;
}

export async function updateDocumentStatus(
  documentId: string,
  status: DocumentRow["status"],
  chunkCount: number,
  client: PoolClient | Client
): Promise<void> {
  await client.query(
    `UPDATE documents
     SET status = $1, chunk_count = $2, updated_at = NOW()
     WHERE document_id = $3`,
    [status, chunkCount, documentId]
  );
}

// chunk queries

export async function insertChunks(
  chunks: ChunkRecord[],
  client: PoolClient | Client
): Promise<void> {
  if (chunks.length === 0) return;

  for (const c of chunks) {
    await client.query(
      `INSERT INTO chunks
        (document_id, content_hash, source, page, section, chunk_index, char_start, char_end, text, token_count, embedding, embed_model, embed_dims, embedded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12, $13, $14)`,
      [
        c.document_id,
        c.content_hash,
        c.source,
        c.page,
        c.section,
        c.chunk_index,
        c.char_start,
        c.char_end,
        c.text,
        c.token_count,
        formatPgVector(c.embedding),
        c.embed_model ?? null,
        c.embed_dims ?? null,
        c.embedded_at ?? null,
      ]
    );
  }
}

function formatPgVector(vec: number[] | null | undefined): string | null {
  if (!vec || vec.length === 0) return null;
  return `[${vec.join(", ")}]`;
}

export async function deleteChunksByDocument(
  documentId: string,
  client: PoolClient | Client
): Promise<void> {
  await client.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);
}

export async function findPendingChunks(
  client: PoolClient | Client,
  limit = 100
): Promise<ChunkRow[]> {
  const res = await client.query<ChunkRow>(
    `SELECT * FROM chunks
     WHERE embedding IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function updateChunkEmbedding(
  chunkId: string,
  embedding: number[],
  embedModel: string,
  embedDims: number,
  client: PoolClient | Client
): Promise<void> {
  await client.query(
    `UPDATE chunks
     SET embedding = $1::vector, embed_model = $2, embed_dims = $3, embedded_at = NOW()
     WHERE chunk_id = $4`,
    [`[${embedding.join(", ")}]`, embedModel, embedDims, chunkId]
  );
}

// dead letter

export async function insertDeadLetter(
  client: PoolClient | Client,
  opts: {
    stage: string;
    itemType: string;
    itemSnapshot: unknown;
    error: string;
    errorCode: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO dead_letters (stage, item_type, item_snapshot, error, error_code)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.stage, opts.itemType, JSON.stringify(opts.itemSnapshot), opts.error, opts.errorCode]
  );
}

// ANN sanity

export async function annSearch(
  queryVector: number[],
  topK = 6,
  client: PoolClient | Client
): Promise<Array<{ chunk_id: string; similarity: number; text: string; source: string; page: number | null }>> {
  const literal = `[${queryVector.join(", ")}]`;
  const res = await client.query<{
    chunk_id: string;
    similarity: number;
    text: string;
    source: string;
    page: number | null;
  }>(
    `SELECT chunk_id, 1 - (embedding <=> $1::vector) AS similarity, text, source, page
     FROM chunks
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [literal, topK]
  );
  return res.rows;
}
