// Ingest orchestrator: file -> extraction -> chunking -> embedding -> persistence.
//
// Invariant: identical source bytes produce identical document_id (idempotency via SHA-256).
// Does NOT version documents, queue ingest jobs, or expose a public API. Those are
// operator-only, local, or future scope.
//
// Flow:
//   1. read file bytes, compute SHA-256 content_hash
//   2. spawn sidecar to extract page-tagged text
//   3. idempotency check against documents.content_hash
//   4. chunk
//   5. embed in batches of ~100, retry 3x
//   6. on embed exhaustion, record chunks with NULL embedding (re-runnable)
//   7. persist document + chunks in a single transaction
//   8. corrupt files are rejected without aborting the batch
//   9. optional namespace prefix for eval isolation
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { chunkDocument } from "./chunker.js";
import { computeContentHash } from "./hash.js";
import { extractFile, type ExtractionResult } from "./pdf_extractor.js";
import { checkIdempotency } from "./idempotency.js";
import { embedTexts, getEmbeddingConfigFromEnv } from "./embedder.js";
import { persistIngest, replaceDocument, routeToDeadLetter } from "./vector_store.js";
import type { ChunkInput, ChunkRecord } from "../types/index.js";
import { logEvent } from "./log.js";

export interface IngestOptions {
  // If true, replace existing document when hash matches. Default: skip.
  replaceOnReingest?: boolean;
  // Override embedding config per-call.
  embedConfig?: Parameters<typeof embedTexts>[1];
  // Namespace prefix for document IDs (e.g. "eval"). Used in EVAL_ENV=prod to
  // keep eval documents out of the production corpus.
  namespace?: string;
}

export interface IngestResult {
  documentId: string | null;
  source: string;
  status: "skipped" | "indexed" | "partial" | "failed";
  pageCount: number;
  chunksTotal: number;
  chunksEmbedded: number;
  chunksUnembedded: number;
  reason?: string;
}

// Ingest a single file (PDF, .txt, .md).
// Returns a result summary. Never throws on known error conditions;
// corrupt files come back as status "failed".
export async function ingestFile(
  filePath: string,
  client: PoolClient,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const traceId = crypto.randomUUID();
  const startTotal = performance.now();
  const source = filePath;
  let extraction: ExtractionResult;

  logEvent({ trace_id: traceId, stage: "ingest", status: "start", query_id: filePath });

  // step 1: read bytes & hash
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    const msg = `Cannot read file: ${(err as Error).message}`;
    logEvent({ trace_id: traceId, stage: "ingest", status: "error", error: msg });
    await routeToDeadLetter(client, {
      stage: "ingest",
      itemType: "document",
      itemSnapshot: { filePath },
      error: msg,
      errorCode: "FILE_READ_ERROR",
    });
    return {
      documentId: null,
      source,
      status: "failed",
      pageCount: 0,
      chunksTotal: 0,
      chunksEmbedded: 0,
      chunksUnembedded: 0,
      reason: msg,
    };
  }

  const contentHash = computeContentHash(buffer);
  logEvent({ trace_id: traceId, stage: "ingest_hash", status: "success" });

  // step 2: extract text via sidecar
  try {
    logEvent({ trace_id: traceId, stage: "ingest_extract", status: "start" });
    extraction = await extractFile(filePath);
    logEvent({ trace_id: traceId, stage: "ingest_extract", status: "success" });
  } catch (err) {
    const msg = `Extraction failed: ${(err as Error).message}`;
    logEvent({ trace_id: traceId, stage: "ingest_extract", status: "error", error: msg });
    await routeToDeadLetter(client, {
      stage: "ingest",
      itemType: "document",
      itemSnapshot: { filePath, contentHash },
      error: msg,
      errorCode: "EXTRACTION_ERROR",
    });
    return {
      documentId: null,
      source,
      status: "failed",
      pageCount: 0,
      chunksTotal: 0,
      chunksEmbedded: 0,
      chunksUnembedded: 0,
      reason: msg,
    };
  }

  // step 3: idempotency check
  const idem = await checkIdempotency(contentHash, client);
  if (idem.action === "skip" && !options.replaceOnReingest) {
    logEvent({ trace_id: traceId, stage: "ingest_idempotency", status: "success", error: "skipped" });
    return {
      documentId: idem.documentId ?? null,
      source,
      status: "skipped",
      pageCount: extraction.page_count,
      chunksTotal: 0,
      chunksEmbedded: 0,
      chunksUnembedded: 0,
      reason: idem.reason,
    };
  }

  // step 4: chunk
  logEvent({ trace_id: traceId, stage: "ingest_chunk", status: "start" });
  const namespacePrefix = options.namespace ? `${options.namespace}_` : "";
  const chunkInput: ChunkInput = {
    source: extraction.source,
    contentHash,
    documentId: idem.documentId ?? `${namespacePrefix}${crypto.randomUUID()}`,
    pages: extraction.pages.map((p) => ({
      page: p.page,
      text: p.text,
    })),
  };

  const chunks = chunkDocument(chunkInput);
  logEvent({ trace_id: traceId, stage: "ingest_chunk", status: "success", total_tokens: chunks.reduce((sum, c) => sum + c.token_count, 0) });

  // step 5: embed
  logEvent({ trace_id: traceId, stage: "ingest_embed", status: "start", total_tokens: chunks.length });
  const textsToEmbed = chunks.map((c) => c.text);
  const embedConfig = options.embedConfig ?? getEmbeddingConfigFromEnv();
  let failedTexts = new Set<string>();
  const embeddingByText = new Map<string, number[]>();

  if (textsToEmbed.length > 0 && embedConfig.apiKey) {
    const embedResult = await embedTexts(textsToEmbed, embedConfig);
    for (const s of embedResult.succeeded) {
      if (!embeddingByText.has(s.text)) {
        embeddingByText.set(s.text, s.embedding);
      }
    }
    for (const f of embedResult.failed) {
      failedTexts.add(f);
    }
  } else if (textsToEmbed.length > 0) {
    // no API key: record everything as un-embedded
    for (const t of textsToEmbed) failedTexts.add(t);
  }

  logEvent({
    trace_id: traceId,
    stage: "ingest_embed",
    status: failedTexts.size > 0 ? "failure" : "success",
    total_tokens: chunks.length,
    error: failedTexts.size > 0 ? `${failedTexts.size} chunks failed embedding` : undefined,
  });

  // step 6: build ChunkRecords
  const chunkRecords: ChunkRecord[] = chunks.map((c) => {
    const isUnembedded = failedTexts.has(c.text);
    const emb = isUnembedded ? null : (embeddingByText.get(c.text) ?? null);
    return {
      chunk_id: crypto.randomUUID(),
      document_id: chunkInput.documentId,
      content_hash: computeContentHash(Buffer.from(c.text)),
      source: c.source,
      page: c.page,
      section: c.section,
      chunk_index: c.chunk_index,
      char_start: c.char_start,
      char_end: c.char_end,
      text: c.text,
      token_count: c.token_count,
      embedding: emb,
      embed_model: isUnembedded ? null : (embedConfig.model ?? null),
      embed_dims: emb?.length ?? null,
      embedded_at: isUnembedded ? null : new Date().toISOString(),
    };
  });

  // step 7: persist
  logEvent({ trace_id: traceId, stage: "ingest_persist", status: "start" });
  let documentId: string;
  let finalStatus: IngestResult["status"] = "indexed";

  try {
    if (idem.action === "skip" && options.replaceOnReingest) {
      const res = await replaceDocument(idem.documentId!, { source: extraction.source, contentHash, pageCount: extraction.page_count, chunks: chunkRecords }, client);
      documentId = res.documentId;
    } else {
      const res = await persistIngest({ source: extraction.source, contentHash, pageCount: extraction.page_count, chunks: chunkRecords }, client);
      documentId = res.documentId;
    }
  } catch (err) {
    const msg = `Persistence failed: ${(err as Error).message}`;
    logEvent({ trace_id: traceId, stage: "ingest_persist", status: "error", error: msg });
    await routeToDeadLetter(client, {
      stage: "ingest",
      itemType: "document",
      itemSnapshot: { filePath, contentHash, chunkCount: chunks.length },
      error: msg,
      errorCode: "PERSISTENCE_ERROR",
    });
    return {
      documentId: null,
      source,
      status: "failed",
      pageCount: extraction.page_count,
      chunksTotal: chunks.length,
      chunksEmbedded: 0,
      chunksUnembedded: 0,
      reason: msg,
    };
  }

  const totalMs = Math.round(performance.now() - startTotal);
  if (failedTexts.size > 0) {
    finalStatus = "partial";
  }

  logEvent({
    trace_id: traceId,
    stage: "ingest",
    status: "success",
    latency_ms: totalMs,
    total_tokens: chunks.length,
    error: finalStatus === "partial" ? `${failedTexts.size} chunks un-embedded` : undefined,
  });

  return {
    documentId,
    source,
    status: finalStatus,
    pageCount: extraction.page_count,
    chunksTotal: chunks.length,
    chunksEmbedded: chunks.length - failedTexts.size,
    chunksUnembedded: failedTexts.size,
    reason: failedTexts.size > 0 ? `${failedTexts.size} chunks un-embedded (re-runnable)` : undefined,
  };
}
