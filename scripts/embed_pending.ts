#!/usr/bin/env tsx
// Re-run embeddings for chunks that previously failed or were un-embedded
// (FR-EM-4).
//
// Usage:
//   npx tsx scripts/embed_pending.ts [--limit N]
//
// Finds chunks where `embedding IS NULL` and `embed_model IS NULL`, batches
// them, calls the embedding API, and updates the rows.
import "dotenv/config";
import { getClient, findPendingChunks, updateChunkEmbedding } from "../src/db.js";
import { embedTexts, getEmbeddingConfigFromEnv } from "../src/embedder.js";
import chunkingDefaults from "../config/chunking.json" with { type: "json" };

async function main() {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]!) : 100;

  const client = await getClient();

  try {
    console.log("Fetching pending chunks...");
    const pending = await findPendingChunks(client, limit);

    if (pending.length === 0) {
      console.log("No pending chunks found. Nothing to do.");
      return;
    }

    console.log(`Found ${pending.length} pending chunks.`);

    const texts = pending.map((c) => c.text);
    const config = getEmbeddingConfigFromEnv();
    config.model ??= chunkingDefaults.embed_model as string;

    console.log(`Embedding with model: ${config.model}`);
    const result = await embedTexts(texts, config);

    // map embeddings back to chunk IDs
    const textToEmbedding = new Map<string, number[]>();
    for (const s of result.succeeded) {
      if (!textToEmbedding.has(s.text)) {
        textToEmbedding.set(s.text, s.embedding);
      }
    }

    let updated = 0;
    for (const chunk of pending) {
      const emb = textToEmbedding.get(chunk.text);
      if (!emb) continue;

      await updateChunkEmbedding(
        chunk.chunk_id,
        emb,
        config.model,
        emb.length,
        client
      );
      updated += 1;
    }

    console.log("\n" + "=".repeat(50));
    console.log(`Re-embedding complete:`);
    console.log(`  Succeeded:  ${result.succeeded.length}`);
    console.log(`  Failed:     ${result.failed.length}`);
    console.log(`  Updated DB: ${updated}`);
    console.log("=".repeat(50));

    if (result.failed.length > 0) {
      console.warn(`Warning: ${result.failed.length} chunks still un-embedded after re-run.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Fatal error: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    client.release();
  }
}

main();
