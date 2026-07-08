/**
 * Retriever — query embed + ANN search (§10.5, FR-RE-1..4).
 *
 * Invariant: the same embedding model and normalisation are used at query time
 *   as at ingest time. Cosine distance via pgvector HNSW is deterministic.
 * Deliberately does NOT: rerank, fuse sparse signals, or filter by metadata.
 *   (those are future scope per SRS §11.3).
 *
 * Uses the same OpenAI embedding model and normalisation as ingest.
 * Single-tier dense retrieval; no re-ranker.
 */
import { embedTexts, getEmbeddingConfigFromEnv } from "./embedder.js";
import { annSearch, getClient } from "./db.js";
import type { PoolClient } from "pg";
import retrievalConfig from "../config/retrieval.json" with { type: "json" };
import type { RetrievedChunk } from "../types/index.js";

export interface RetrieveOptions {
  question: string;
  topK?: number;
  client?: PoolClient;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  topScore: number;
}

export async function retrieveChunks(
  opts: RetrieveOptions
): Promise<RetrieveResult> {
  const { question, topK = retrievalConfig.top_k } = opts;

  // 1. Embed the query with the same model as ingest
  const embedConfig = getEmbeddingConfigFromEnv();
  const embedResult = await embedTexts([question], embedConfig);
  if (embedResult.failed.length > 0 || embedResult.succeeded.length === 0) {
    throw new Error(`Query embedding failed: ${embedResult.failed[0] ?? "unknown"}`);
  }
  const queryVector = embedResult.succeeded[0]!.embedding;

  // 2. ANN search via pgvector
  const ownClient = !opts.client;
  const client = opts.client ?? (await getClient());
  try {
    const rows = await annSearch(queryVector, topK, client);

    const chunks: RetrievedChunk[] = rows.map((r) => ({
      chunk_id: r.chunk_id,
      source: r.source,
      page: r.page,
      text: r.text,
      similarity: Number(r.similarity),
    }));

    const topScore = chunks.length > 0 ? Math.max(...chunks.map((c) => c.similarity)) : 0;
    return { chunks, topScore };
  } finally {
    if (ownClient) client.release();
  }
}
